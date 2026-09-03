/**
 * Engine-neutral TTS contract. ElevenLabs (elevenlabs.ts) and Deepgram Aura (deepgram-tts.ts)
 * implement it; session-voice.ts only talks to these types and picks the engine per turn:
 * ElevenLabs while it has a key, has not failed twice in the turn and is not resting after a
 * bad turn, then Deepgram Aura under the same conditions, otherwise text only.
 */

import type { Lang } from "../domain/lang";

export type TtsEngineName = "elevenlabs" | "deepgram" | "none";
export type TtsVendor = Exclude<TtsEngineName, "none">;

/** PCM 16 kHz mono Int16: 32 bytes per millisecond of audio. */
const PCM_BYTES_PER_MS = 32;

/**
 * Speaking-rate floors, ms of audio per character of input text, used to decide which written
 * chunks a dead stream had really delivered. Measured 2026-09-03 (scratch/vendor-checks.md,
 * scratch/vendor-dg-speak.ts): ElevenLabs flash v2.5 about 47 ms/char (3.3 s for 70 chars),
 * Aura-2 about 70 ms/char (2.1 s for 30 chars). The floors sit below those numbers so a chunk
 * whose audio fully arrived is not re-sent, while a chunk with clearly too little audio behind
 * it is. When the estimate is wrong it errs toward a repeated sentence, never a missing one.
 */
export const MS_PER_CHAR_FLOOR: Record<TtsVendor, number> = { elevenlabs: 40, deepgram: 60 };

/**
 * Chunks a dying stream did not deliver, in order. An engine synthesizes a socket's chunks one
 * after the other, so chunk k counts as delivered only when it was written before the latest
 * audio frame AND the audio received so far is at least the estimated duration of chunks 0..k
 * (`msPerChar` floor); from the first chunk that fails this test everything after it is lost as
 * well. With no audio at all, everything written is lost.
 */
export function lostChunks(sent: readonly string[], sentAtLastAudio: number, audioBytes: number, msPerChar: number): string[] {
  if (audioBytes <= 0) return [...sent];
  const audioMs = audioBytes / PCM_BYTES_PER_MS;
  const candidates = Math.min(sentAtLastAudio, sent.length);
  let expectedMs = 0;
  let delivered = 0;
  for (let i = 0; i < candidates; i++) {
    expectedMs += sent[i].trim().length * msPerChar;
    if (expectedMs > audioMs) break;
    delivered = i + 1;
  }
  return sent.slice(delivered);
}

export interface TtsStreamEvents {
  /** Decoded PCM 16 kHz Int16 bytes. Never called after cancel(). */
  onAudio(stream: TtsStream, pcm: Buffer): void;
  /** The engine drained everything after our flush. Never called after cancel(). */
  onEnd(stream: TtsStream): void;
  /**
   * Socket or API error. Never called after cancel(). Inspect `stream.idle` (nothing was ever
   * sent, nothing lost), `stream.lostText` (chunks that did not produce audio, see lostChunks)
   * and `stream.flushWasRequested` to decide whether to re-send on a replacement stream.
   */
  onError(stream: TtsStream, err: Error): void;
}

/** One per turn and engine: the socket that turns sentences into PCM. */
export interface TtsStream {
  readonly id: string;
  readonly engine: TtsVendor;
  readonly cancelled: boolean;
  /**
   * True while text can still be sent on this stream. False as soon as the socket leaves OPEN,
   * which happens on the close frame, before the close event: a stream that is not alive and
   * has not reported an error yet is in its close handshake and must be retired by the owner.
   */
  readonly isAlive: boolean;
  /** PCM bytes received from the engine so far. */
  readonly bytesSent: number;
  /**
   * Text that did not produce audio, in order: every chunk written when no audio at all came
   * back, otherwise the chunks written after the latest audio frame plus any earlier chunk the
   * audio received cannot have covered (see lostChunks), followed by whatever is still queued.
   */
  readonly lostText: string[];
  /** At least one text chunk was written to the socket (its audio may or may not have arrived). */
  readonly textWasSent: boolean;
  readonly flushWasRequested: boolean;
  /**
   * The socket opened fine and then went away before any text was sent and without an API
   * error: the pre-opened stream hit an inactivity timeout during a long model turn. Nothing
   * was lost and it is not counted as an engine failure; the next sentence opens a new socket.
   */
  readonly idle: boolean;
  /** Send one sentence. Queued until the socket is open. */
  sendText(text: string): void;
  /** End of input for this turn; the engine drains the remaining audio and then onEnd fires. */
  flush(): void;
  /** Barge-in / teardown: drop the socket and silence every callback from now on. */
  cancel(): void;
}

export interface TtsEngine {
  readonly name: TtsVendor;
  /**
   * Languages the engine can speak. The session only picks an engine that lists the turn's
   * language: ElevenLabs flash v2.5 speaks English and Turkish with the same voice, Deepgram
   * Aura (aura-2-thalia-en) is English only, so a Turkish turn never falls back to it.
   */
  readonly languages: readonly Lang[];
  openStream(events: TtsStreamEvents, lang?: Lang): TtsStream;
}

let failSeq = 0;

/**
 * Chaos stand-in (fail=tts): behaves like a stream whose socket was rejected right after the
 * init message. It never opens a connection, keeps every sentence as lost text and reports
 * the failure on the next tick, so the session's ordinary retry / fallback path runs unchanged.
 */
export class FailingTtsStream implements TtsStream {
  readonly id: string;
  private readonly sent: string[] = [];
  private flushRequested = false;
  private _cancelled = false;
  private ended = false;

  constructor(
    readonly engine: TtsVendor,
    private readonly events: TtsStreamEvents,
    private readonly reason: string,
  ) {
    this.id = `${engine}-chaos${++failSeq}`;
    setImmediate(() => this.fail());
  }

  get cancelled(): boolean {
    return this._cancelled;
  }
  get isAlive(): boolean {
    return !this._cancelled && !this.ended && !this.flushRequested;
  }
  get bytesSent(): number {
    return 0;
  }
  get lostText(): string[] {
    return [...this.sent];
  }
  get textWasSent(): boolean {
    return this.sent.length > 0;
  }
  get flushWasRequested(): boolean {
    return this.flushRequested;
  }
  /** Never idle: the failure must be counted against the engine. */
  get idle(): boolean {
    return false;
  }

  sendText(text: string): void {
    if (!this.isAlive) return;
    this.sent.push(text.endsWith(" ") ? text : text + " ");
  }
  flush(): void {
    if (this._cancelled || this.ended) return;
    this.flushRequested = true;
  }
  cancel(): void {
    this._cancelled = true;
  }

  private fail(): void {
    if (this._cancelled || this.ended) return;
    this.ended = true;
    this.events.onError(this, new Error(`${this.engine} stream failed (${this.reason})`));
  }
}
