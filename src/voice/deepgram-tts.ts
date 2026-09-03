/**
 * Deepgram Aura streaming TTS over a raw `ws` socket (the `/v1/speak` WebSocket). Fallback
 * engine behind ElevenLabs; same per-turn stream contract (tts.ts).
 *
 * Contract as verified live on 2026-09-03 (scratch/vendor-dg-speak.ts): connect with
 * `Authorization: Token <key>`; the first server message is `{type:"Metadata", request_id,
 * model_name, ...}`. `{type:"Speak", text}` per sentence; Aura synthesizes complete sentences
 * as they arrive (first raw PCM frame 250 ms after a Speak, no Flush needed), so one
 * `{type:"Flush"}` at the end of the turn is enough to drain a trailing fragment and get
 * `{type:"Flushed", sequence_id}` back. Audio is binary frames of raw 16 kHz Int16 PCM (about
 * 1280 bytes each, no WAV header). The socket stays usable across flushes; `{type:"Close"}`
 * makes the server close with 1000. `{type:"Error", description}` is the API error shape.
 */
import WebSocket from "ws";
import type { RawData } from "ws";
import { lostChunks, MS_PER_CHAR_FLOOR, type TtsEngine, type TtsStream, type TtsStreamEvents } from "./tts";
import { vendorUrlOverride } from "./vendor-url";

export const DEEPGRAM_TTS_MODEL = "aura-2-thalia-en";

/**
 * Test hook: DEEPGRAM_SPEAK_WS_URL points the client at a mock server (loopback, or any host with
 * ALLOW_VENDOR_URL_OVERRIDE=1; see vendor-url.ts). Production uses the real host.
 */
export function deepgramSpeakUrl(model: string = DEEPGRAM_TTS_MODEL): string {
  const base = vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL") ?? "wss://api.deepgram.com";
  return `${base}/v1/speak?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=16000`;
}

function toBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

let streamSeq = 0;

export class DeepgramAuraStream implements TtsStream {
  readonly id: string;
  readonly engine = "deepgram" as const;
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
    model: string,
    private readonly events: TtsStreamEvents,
  ) {
    this.id = `aura${++streamSeq}`;
    this.ws = new WebSocket(deepgramSpeakUrl(model), { headers: { Authorization: `Token ${apiKey}` } });
    this.ws.on("open", () => {
      if (this._cancelled) return;
      this.ready = true;
      const queued = this.queue;
      this.queue = [];
      for (const t of queued) this.rawSend(t);
      if (this.flushRequested) this.rawFlush();
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) this.handleAudio(toBuffer(data));
      else this.handleJson(toBuffer(data).toString("utf8"));
    });
    this.ws.on("error", (err) => {
      if (this._cancelled || this.ended) return;
      this.ended = true;
      this.events.onError(this, err instanceof Error ? err : new Error(String(err)));
    });
    this.ws.on("close", (code, reason) => {
      if (this._cancelled || this.ended) return;
      this.ended = true;
      if (this.flushRequested && code === 1000) {
        // Clean close after our Flush without an explicit Flushed: treat as drained.
        this.events.onEnd(this);
      } else {
        this.events.onError(this, new Error(`deepgram speak socket closed ${code} ${reason.toString()}`.trim()));
      }
    });
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  get isAlive(): boolean {
    return !this._cancelled && !this.ended && !this.flushRequested && this.ws.readyState <= WebSocket.OPEN;
  }

  get bytesSent(): number {
    return this.audioBytes;
  }

  /** See lostChunks in tts.ts; the Aura speaking-rate floor decides what the audio received covered. */
  get lostText(): string[] {
    return [...lostChunks(this.sent, this.sentAtLastAudio, this.audioBytes, MS_PER_CHAR_FLOOR.deepgram), ...this.queue];
  }

  get textWasSent(): boolean {
    return this.textSent;
  }

  get flushWasRequested(): boolean {
    return this.flushRequested;
  }

  get idle(): boolean {
    return this.ready && !this.textSent && this.queue.length === 0 && !this.flushRequested && !this.apiError;
  }

  sendText(text: string): void {
    if (!this.isAlive) return;
    const chunk = text.endsWith(" ") ? text : text + " ";
    if (this.ready) this.rawSend(chunk);
    else this.queue.push(chunk);
  }

  flush(): void {
    if (this._cancelled || this.ended || this.flushRequested) return;
    this.flushRequested = true;
    if (this.ready) this.rawFlush();
  }

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
    this.ws.send(JSON.stringify({ type: "Speak", text: chunk }));
    this.textSent = true;
    this.sent.push(chunk);
  }

  private rawFlush(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "Flush" }));
  }

  private closeSocket(): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Close" }));
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private handleAudio(pcm: Buffer): void {
    if (this._cancelled || this.ended || pcm.length === 0) return;
    this.audioBytes += pcm.length;
    this.sentAtLastAudio = this.sent.length;
    this.events.onAudio(this, pcm);
  }

  private handleJson(raw: string): void {
    if (this._cancelled || this.ended) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.type) {
      case "Flushed":
        if (!this.flushRequested) return; // a flush we did not ask for: nothing to conclude
        this.ended = true;
        this.events.onEnd(this);
        this.closeSocket();
        return;
      case "Error":
        this.ended = true;
        this.apiError = true;
        this.events.onError(this, new Error(`deepgram speak: ${msg.description ?? msg.message ?? raw}`));
        this.closeSocket();
        return;
      default:
        return; // Metadata, Warning, Cleared
    }
  }
}

export class DeepgramTts implements TtsEngine {
  readonly name = "deepgram" as const;
  constructor(
    private readonly apiKey: string,
    readonly model: string = DEEPGRAM_TTS_MODEL,
  ) {}

  openStream(events: TtsStreamEvents): TtsStream {
    return new DeepgramAuraStream(this.apiKey, this.model, events);
  }
}
