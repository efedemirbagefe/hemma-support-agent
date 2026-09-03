/**
 * ElevenLabs streaming TTS over a raw `ws` socket (stream-input endpoint).
 *
 * The stream-input protocol is one socket per utterance: init message, N text chunks,
 * `{ text: "" }` to flush, then audio until `isFinal`, then the server closes. So the
 * `ElevenLabsTts` object is the per-connection config holder and `ElevenLabsStream` is the
 * per-turn socket (the engine-neutral `TtsStream` contract lives in tts.ts). A stream is opened at t0 (before the model has said anything) so the
 * connect cost hides behind the model's time-to-first-token.
 */
import WebSocket from "ws";
import { lostChunks, MS_PER_CHAR_FLOOR, type TtsEngine, type TtsStream, type TtsStreamEvents } from "./tts";
import { vendorUrlOverride } from "./vendor-url";

export type { TtsStream, TtsStreamEvents } from "./tts";

/**
 * Sarah, a premade voice present in every ElevenLabs workspace. Measured 2026-09-03
 * (scratch/vendor-checks.md): the library voice Rachel (21m00Tcm4TlvDq8ikWAM) answers 402
 * paid_plan_required on a free workspace, so it is not a safe default; Sarah returned 200.
 * VOICE_ID / ELEVENLABS_VOICE_ID override it.
 */
export const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
export const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
/**
 * Seconds ElevenLabs keeps the socket open with no text (their default is 20, max 180). The
 * stream is opened at t0 and a turn with tool calls can stay silent for a while, so use the max.
 */
export const ELEVENLABS_INACTIVITY_TIMEOUT_S = 180;

export interface TtsVoiceSettings {
  stability: number;
  similarity_boost: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

const DEFAULT_VOICE_SETTINGS: TtsVoiceSettings = { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false };

export function elevenLabsUrl(voiceId: string): string {
  // Test hook: ELEVENLABS_WS_URL points the client at a mock server (loopback, or any host with
  // ALLOW_VENDOR_URL_OVERRIDE=1; see vendor-url.ts). Production uses the real host.
  const base = vendorUrlOverride("ELEVENLABS_WS_URL") ?? "wss://api.elevenlabs.io";
  return (
    `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
    `?model_id=${ELEVENLABS_MODEL_ID}&output_format=pcm_16000&inactivity_timeout=${ELEVENLABS_INACTIVITY_TIMEOUT_S}`
  );
}

let streamSeq = 0;

export class ElevenLabsStream implements TtsStream {
  readonly id: string;
  readonly engine = "elevenlabs" as const;
  private readonly ws: WebSocket;
  private ready = false;
  private queue: string[] = [];
  private flushRequested = false;
  private ended = false;
  private _cancelled = false;
  private audioBytes = 0;
  private textSent = false;
  private sent: string[] = [];
  /** `sent.length` when the latest audio frame arrived: chunks written after it produced nothing. */
  private sentAtLastAudio = 0;
  private apiError = false;

  constructor(
    apiKey: string,
    voiceId: string,
    voiceSettings: TtsVoiceSettings,
    private readonly events: TtsStreamEvents,
  ) {
    this.id = `tts${++streamSeq}`;
    this.ws = new WebSocket(elevenLabsUrl(voiceId), { headers: { "xi-api-key": apiKey } });
    this.ws.on("open", () => {
      if (this._cancelled) return;
      this.ready = true;
      this.ws.send(
        JSON.stringify({
          text: " ",
          voice_settings: voiceSettings,
          generation_config: { chunk_length_schedule: [50, 90, 120, 150] },
          xi_api_key: apiKey,
        }),
      );
      const queued = this.queue;
      this.queue = [];
      for (const t of queued) this.rawSend(t);
      if (this.flushRequested) this.rawFlush();
    });
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("error", (err) => {
      if (this._cancelled || this.ended) return;
      this.ended = true;
      this.events.onError(this, err instanceof Error ? err : new Error(String(err)));
    });
    this.ws.on("close", (code, reason) => {
      if (this._cancelled || this.ended) return;
      this.ended = true;
      if (this.flushRequested && code === 1000) {
        // Some closes arrive without an explicit isFinal; treat a clean close after EOS as end.
        this.events.onEnd(this);
      } else {
        this.events.onError(this, new Error(`elevenlabs socket closed ${code} ${reason.toString()}`.trim()));
      }
    });
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  /** True while text can still be sent on this stream. */
  get isAlive(): boolean {
    return !this._cancelled && !this.ended && !this.flushRequested && this.ws.readyState <= WebSocket.OPEN;
  }

  get bytesSent(): number {
    return this.audioBytes;
  }

  /**
   * Text that did not produce audio, in order (see lostChunks in tts.ts): everything written
   * when no audio at all came back (rejected at init, died before its first generation),
   * otherwise the chunks written after the latest audio frame plus any earlier chunk the audio
   * received cannot have covered at the ElevenLabs speaking-rate floor, then the queue.
   */
  get lostText(): string[] {
    return [...lostChunks(this.sent, this.sentAtLastAudio, this.audioBytes, MS_PER_CHAR_FLOOR.elevenlabs), ...this.queue];
  }

  /** At least one text chunk was written to the socket (its audio may or may not have arrived). */
  get textWasSent(): boolean {
    return this.textSent;
  }

  get flushWasRequested(): boolean {
    return this.flushRequested;
  }

  /**
   * The socket opened fine and then closed or errored before any text was sent and without an
   * API error message: typically the pre-opened stream hitting ElevenLabs' inactivity timeout
   * during a long model turn. Nothing was lost; the next sentence just needs a new socket.
   */
  get idle(): boolean {
    return this.ready && !this.textSent && this.queue.length === 0 && !this.flushRequested && !this.apiError;
  }

  /** Send one sentence. Queued until the socket is open. */
  sendText(text: string): void {
    if (!this.isAlive) return;
    const chunk = text.endsWith(" ") ? text : text + " ";
    if (this.ready) this.rawSend(chunk);
    else this.queue.push(chunk);
  }

  /** End of input for this turn; server will drain the remaining audio and send isFinal. */
  flush(): void {
    if (this._cancelled || this.ended || this.flushRequested) return;
    this.flushRequested = true;
    if (this.ready) this.rawFlush();
  }

  /** Barge-in / teardown: drop the socket and silence every callback from now on. */
  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.queue = [];
    try {
      this.ws.terminate();
    } catch {
      /* already closed */
    }
  }

  private rawSend(chunk: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      // Socket is going away; keep the chunk so a replacement stream can re-send it.
      this.queue.push(chunk);
      return;
    }
    this.ws.send(JSON.stringify({ text: chunk, flush: true }));
    this.textSent = true;
    this.sent.push(chunk);
  }

  private rawFlush(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ text: "" }));
  }

  private handleMessage(raw: string): void {
    if (this._cancelled || this.ended) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg?.audio === "string" && msg.audio.length > 0) {
      const pcm = Buffer.from(msg.audio, "base64");
      this.audioBytes += pcm.length;
      this.sentAtLastAudio = this.sent.length;
      this.events.onAudio(this, pcm);
    }
    if (msg?.error || (typeof msg?.code === "number" && msg.code >= 1000 && msg?.message)) {
      this.ended = true;
      this.apiError = true;
      this.events.onError(this, new Error(`elevenlabs: ${msg.message ?? msg.error}`));
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg?.isFinal === true) {
      this.ended = true;
      this.events.onEnd(this);
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export class ElevenLabsTts implements TtsEngine {
  readonly name = "elevenlabs" as const;
  readonly voiceId: string;
  constructor(
    private readonly apiKey: string,
    voiceId?: string,
    private readonly voiceSettings: TtsVoiceSettings = DEFAULT_VOICE_SETTINGS,
  ) {
    this.voiceId = voiceId && voiceId.trim() ? voiceId.trim() : DEFAULT_VOICE_ID;
  }

  openStream(events: TtsStreamEvents): TtsStream {
    return new ElevenLabsStream(this.apiKey, this.voiceId, this.voiceSettings, events);
  }
}
