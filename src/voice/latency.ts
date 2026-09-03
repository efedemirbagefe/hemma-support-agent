/**
 * Per-turn latency bookkeeping.
 *
 * All timestamps are wall-clock ms (Date.now()) on the server. `t0` is the moment the
 * user turn became final (Deepgram speech_final / UtteranceEnd, or text receipt). Every
 * other number in the report is measured relative to t0, except `sttFinalMs`, which is
 * measured *backwards* from t0 to the estimated wall time the user stopped speaking.
 */
import type { TtsEngineName, TtsVendor } from "./tts";

/** voice: a Deepgram final; text: a typed message; greet: the fixed opening line, no model call. */
export type TurnSource = "voice" | "text" | "greet";

export interface LatencyReport {
  type: "latency";
  turnId: string;
  source: TurnSource;
  /** Estimated ms between end of user speech (audio clock) and the final transcript. 0 for text turns. */
  sttFinalMs: number;
  /** t0 -> first assistant text_delta. null if the model produced no text (abort, error). */
  firstTokenMs: number | null;
  /** t0 -> first PCM frame sent to the client. null when nothing was synthesized. */
  firstAudioMs: number | null;
  /** t0 -> client reported that the first chunk of this turn started playing. null if not reported. */
  playedMs: number | null;
  /** Sum of tool_execution_start -> tool_execution_end for all tools in the turn. */
  toolMs: number;
  /** t0 -> turn fully finished (agent idle and TTS drained / cancelled). */
  totalMs: number | null;
  cancelled: boolean;
  /**
   * Engine that produced the turn's first audio frame, i.e. the one `firstAudioMs` measures;
   * "none" when no audio was sent.
   */
  ttsEngine: TtsEngineName;
  /**
   * Every engine whose audio the client got this turn, in order of first frame. Two entries
   * after a mid-turn fallback (ElevenLabs spoke the head, Aura the tail); empty with no audio.
   */
  ttsEngines: TtsVendor[];
}

export class TurnLatency {
  readonly t0: number;
  readonly sttFinalMs: number;
  firstTokenAt?: number;
  firstAudioAt?: number;
  playedAt?: number;
  endedAt?: number;
  toolMs = 0;
  cancelled = false;
  ttsEngine: TtsEngineName = "none";
  ttsEngines: TtsVendor[] = [];

  constructor(readonly turnId: string, readonly source: TurnSource, t0: number, sttFinalMs: number) {
    this.t0 = t0;
    this.sttFinalMs = Math.max(0, Math.round(sttFinalMs));
  }

  markFirstToken(at = Date.now()): void {
    if (this.firstTokenAt === undefined) this.firstTokenAt = at;
  }

  markFirstAudio(at = Date.now()): void {
    if (this.firstAudioAt === undefined) this.firstAudioAt = at;
  }

  markPlayed(at = Date.now()): void {
    if (this.playedAt === undefined) this.playedAt = at;
  }

  addToolMs(ms: number): void {
    this.toolMs += Math.max(0, ms);
  }

  markEnd(at = Date.now()): void {
    if (this.endedAt === undefined) this.endedAt = at;
  }

  report(): LatencyReport {
    const rel = (at?: number): number | null => (at === undefined ? null : Math.max(0, at - this.t0));
    return {
      type: "latency",
      turnId: this.turnId,
      source: this.source,
      sttFinalMs: this.sttFinalMs,
      firstTokenMs: rel(this.firstTokenAt),
      firstAudioMs: rel(this.firstAudioAt),
      playedMs: rel(this.playedAt),
      toolMs: Math.round(this.toolMs),
      totalMs: rel(this.endedAt),
      cancelled: this.cancelled,
      ttsEngine: this.ttsEngine,
      ttsEngines: [...this.ttsEngines],
    };
  }
}

/** One JSON line per turn on stdout. Human logs go to stderr so stdout stays machine-readable. */
export function logLatencyLine(report: LatencyReport, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ ...report, ...extra, at: new Date().toISOString() }) + "\n");
}

/** PCM 16 kHz mono Int16: 32 000 bytes per second. */
export function pcmBytesToMs(bytes: number): number {
  return bytes / 32;
}
