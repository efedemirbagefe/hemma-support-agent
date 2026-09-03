/**
 * Deepgram live STT over a raw `ws` socket. No SDK, no reconnect inside this class: when the
 * socket dies the owner is told via onClose and decides what to do (the VoiceSession reopens
 * it with a backoff on the next audio frame).
 */
import WebSocket from "ws";
import { DEFAULT_LANG, type Lang } from "../domain/lang";
import { vendorUrlOverride } from "./vendor-url";

/**
 * Listen model per language. Nova-3 does not list Turkish, so "tr" runs on nova-2 with an
 * explicit language; English keeps nova-3 (auto language). Measured 2026-09-03
 * (scratch/vendor-dg-live-lang.ts, macOS `say -v Yelda` clip): nova-2 tr returned
 * "Merhaba, en son siparişim ne durumda?" exactly, confidence 0.97, speech_final after 300 ms
 * endpointing like the English socket.
 */
export const DEEPGRAM_STT_MODELS: Record<Lang, { model: string; language?: string }> = {
  en: { model: "nova-3" },
  tr: { model: "nova-2", language: "tr" },
};

/** Everything but the model: identical for both languages. */
const LISTEN_PARAMS =
  "encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&vad_events=true&smart_format=true";

export function deepgramListenQuery(lang: Lang = DEFAULT_LANG): string {
  const m = DEEPGRAM_STT_MODELS[lang];
  return `model=${m.model}${m.language ? `&language=${m.language}` : ""}&${LISTEN_PARAMS}`;
}

export function deepgramListenUrl(lang: Lang = DEFAULT_LANG): string {
  return `wss://api.deepgram.com/v1/listen?${deepgramListenQuery(lang)}`;
}

/** Short model name for logs: "nova-3" or "nova-2 tr". */
export function describeSttModel(lang: Lang): string {
  const m = DEEPGRAM_STT_MODELS[lang];
  return m.language ? `${m.model} ${m.language}` : m.model;
}

/** The English socket URL as documented in CONTRACTS.md. */
export const DEEPGRAM_URL = deepgramListenUrl("en");

export const KEEPALIVE_INTERVAL_MS = 8000;
/** PCM 16 kHz mono Int16: 32 bytes per millisecond. */
export const PCM_BYTES_PER_MS = 32;
/** Audio buffered while the socket is still connecting (2 s), so the first words are not lost. */
export const PRE_OPEN_BUFFER_BYTES = 2000 * PCM_BYTES_PER_MS;

/**
 * Test hook: DEEPGRAM_WS_URL points the client at a mock server (loopback, or any host with
 * ALLOW_VENDOR_URL_OVERRIDE=1; see vendor-url.ts); the model query is appended so a mock can
 * see which model a socket asked for. Production uses deepgramListenUrl(lang).
 */
function resolveUrl(lang: Lang): string {
  const override = vendorUrlOverride("DEEPGRAM_WS_URL");
  if (!override) return deepgramListenUrl(lang);
  return `${override}${override.includes("?") ? "&" : "?"}${deepgramListenQuery(lang)}`;
}

export interface FinalMeta {
  /**
   * Estimated wall-clock ms at which the user stopped speaking. Deepgram stamps words on its
   * audio clock (seconds of audio received on this socket). We know how much audio we have sent
   * (bytesSent / 32 ms) and when the last frame went out, so the wall time of the speech end is
   * `wallAtLastFrame - (audioSentMs - speechEndMs)`. Re-anchoring on every frame means a gap in
   * the mic stream (Stop/Start mic, tab throttling) does not inflate later measurements.
   * Undefined before any audio was sent.
   */
  speechEndWall?: number;
}

export interface DeepgramEvents {
  onOpen?(): void;
  /** Interim transcript for display: accumulated finals of this utterance + current partial. */
  onInterim(text: string): void;
  /** A complete user turn (speech_final, or UtteranceEnd after finals). */
  onFinal(text: string, meta: FinalMeta): void;
  /** VAD says the user started talking. */
  onSpeechStarted(): void;
  onError(err: Error): void;
  onClose(code: number, reason: string): void;
}

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
}

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }> };
}

export class DeepgramStt {
  private readonly ws: WebSocket;
  private keepAlive?: NodeJS.Timeout;
  private closeGuard?: NodeJS.Timeout;
  private opened = false;
  private closed = false;
  private finals: string[] = [];
  private lastSpeechEndSec = 0;
  private bytesSent = 0;
  private wallAtLastFrame?: number;
  private preOpen: Buffer[] = [];
  private preOpenBytes = 0;
  private dropped = 0;

  constructor(
    apiKey: string,
    private readonly events: DeepgramEvents,
    readonly lang: Lang = DEFAULT_LANG,
  ) {
    this.ws = new WebSocket(resolveUrl(lang), { headers: { Authorization: `Token ${apiKey}` } });
    this.ws.on("open", () => {
      this.opened = true;
      this.keepAlive = setInterval(() => this.sendJson({ type: "KeepAlive" }), KEEPALIVE_INTERVAL_MS);
      // Audio that arrived while connecting goes out first, as one frame.
      if (this.preOpen.length > 0) {
        const buffered = Buffer.concat(this.preOpen);
        this.preOpen = [];
        this.preOpenBytes = 0;
        this.rawSendAudio(buffered);
      }
      this.events.onOpen?.();
    });
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("error", (err) => this.events.onError(err instanceof Error ? err : new Error(String(err))));
    this.ws.on("close", (code, reason) => {
      this.cleanup();
      this.events.onClose(code, reason.toString());
    });
  }

  get isOpen(): boolean {
    return this.opened && !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** True while the socket is still being established (audio is buffered, not dropped). */
  get isConnecting(): boolean {
    return !this.closed && !this.opened && this.ws.readyState === WebSocket.CONNECTING;
  }

  /**
   * Forward a PCM16 16 kHz frame. While the socket is connecting the frame is buffered (up to
   * PRE_OPEN_BUFFER_BYTES, oldest dropped). Returns false if the frame was dropped.
   */
  sendAudio(pcm: Buffer): boolean {
    if (this.isOpen) {
      this.rawSendAudio(pcm);
      return true;
    }
    if (this.isConnecting) {
      this.preOpen.push(pcm);
      this.preOpenBytes += pcm.length;
      while (this.preOpenBytes > PRE_OPEN_BUFFER_BYTES && this.preOpen.length > 1) {
        const oldest = this.preOpen.shift()!;
        this.preOpenBytes -= oldest.length;
        this.dropped++;
      }
      return true;
    }
    this.dropped++;
    return false;
  }

  get droppedFrames(): number {
    return this.dropped;
  }

  /** Milliseconds of audio handed to Deepgram so far (its audio clock at the last frame). */
  get audioSentMs(): number {
    return this.bytesSent / PCM_BYTES_PER_MS;
  }

  /** Graceful teardown: CloseStream, then close, with a hard terminate fallback. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.preOpen = [];
    this.preOpenBytes = 0;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* socket already going away */
      }
      this.ws.close();
      this.closeGuard = setTimeout(() => this.ws.terminate(), 1000);
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }

  private rawSendAudio(pcm: Buffer): void {
    this.ws.send(pcm, { binary: true });
    this.bytesSent += pcm.length;
    this.wallAtLastFrame = Date.now();
  }

  private cleanup(): void {
    this.closed = true;
    this.preOpen = [];
    this.preOpenBytes = 0;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.closeGuard) clearTimeout(this.closeGuard);
    this.keepAlive = undefined;
    this.closeGuard = undefined;
  }

  private sendJson(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.type) {
      case "Results":
        this.handleResults(msg as DeepgramResults);
        return;
      case "UtteranceEnd":
        if (typeof msg.last_word_end === "number") this.lastSpeechEndSec = msg.last_word_end;
        if (this.finals.length > 0) this.emitTurn();
        return;
      case "SpeechStarted":
        this.events.onSpeechStarted();
        return;
      case "Error":
        this.events.onError(new Error(`deepgram: ${msg.description ?? msg.message ?? raw}`));
        return;
      default:
        return; // Metadata and friends
    }
  }

  private handleResults(msg: DeepgramResults): void {
    const alt = msg.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (msg.is_final) {
      if (text) {
        this.finals.push(text);
        const lastWord = alt?.words?.[alt.words.length - 1];
        if (lastWord && typeof lastWord.end === "number") this.lastSpeechEndSec = lastWord.end;
        else if (typeof msg.start === "number" && typeof msg.duration === "number") {
          this.lastSpeechEndSec = msg.start + msg.duration;
        }
      }
      if (msg.speech_final && this.finals.length > 0) this.emitTurn();
      return;
    }
    if (text) {
      const shown = [...this.finals, text].join(" ");
      this.events.onInterim(shown);
    }
  }

  private emitTurn(): void {
    const text = this.finals.join(" ").trim();
    this.finals = [];
    if (!text) return;
    let speechEndWall: number | undefined;
    if (this.wallAtLastFrame !== undefined) {
      const behindMs = this.audioSentMs - this.lastSpeechEndSec * 1000;
      speechEndWall = this.wallAtLastFrame - Math.max(0, behindMs);
    }
    this.events.onFinal(text, { speechEndWall });
  }
}
