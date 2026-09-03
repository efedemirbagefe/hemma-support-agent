/**
 * One browser connection = one VoiceSession: a domain Session, a SupportAgent, a Deepgram
 * STT socket (opened on the first mic frame, reopened with a backoff if it drops) and (per
 * turn) a TTS stream: ElevenLabs first, Deepgram Aura as the fallback. See README-voice.md
 * for the turn lifecycle and where each latency timestamp is taken.
 */
import { randomBytes } from "node:crypto";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createSupportAgent, type SupportAgent } from "../agent/createAgent";
import { Session, type SessionSnapshot } from "../domain/session";
import { ChaosState, instrumentTools, type ChaosFlag } from "./chaos";
import { DeepgramStt } from "./deepgram";
import { DeepgramTts } from "./deepgram-tts";
import { ElevenLabsTts } from "./elevenlabs";
import { SentenceChunker } from "./chunker";
import { TurnLatency, logLatencyLine, pcmBytesToMs, type LatencyReport, type TurnSource } from "./latency";
import { FailingTtsStream, type TtsEngine, type TtsEngineName, type TtsStream, type TtsVendor } from "./tts";

export const FILLER_AFTER_MS = 700;
export const FILLER_TEXT = "One moment, let me check that.";
/** How long after a turn ends we wait for the client's `played` report before writing the stdout line. */
export const PLAYED_GRACE_MS = 2000;
/**
 * A barge-in (Deepgram SpeechStarted) cancels the running answer. If no transcript follows
 * within this window (cough, click, echo leak, VAD false trigger) the interrupted question is
 * answered again, so the customer is never left in silence.
 */
export const RESUME_AFTER_BARGE_IN_MS = 1800;
/** How many times one user turn may be re-answered after silent barge-ins. */
export const MAX_RESUMES = 2;
/** Longest text message accepted from the client. */
export const MAX_TEXT_CHARS = 2000;
/** Deepgram reconnect backoff per failed attempt; after the last one we stop until the cooldown. */
export const STT_RECONNECT_BACKOFF_MS = [500, 1500, 4000];
export const STT_RECONNECT_COOLDOWN_MS = 60_000;
/**
 * Streams one engine may open per turn: the first one plus one replacement. After that the
 * turn moves on to the next engine (ElevenLabs -> Deepgram Aura), then to text only, and the
 * engine is rested for TTS_ENGINE_COOLDOWN_MS.
 */
export const MAX_TTS_STREAMS_PER_ENGINE = 2;
/**
 * An engine that used up its streams in one turn is left out of the rotation for this long, so
 * a dead or over-quota key does not cost every turn a connect-and-reject (about a second with
 * the Aura open behind it) before the fallback speaks. Per connection; a reset clears it.
 */
export const TTS_ENGINE_COOLDOWN_MS = 60_000;

export interface VoiceSessionOptions {
  /** Deepgram key for STT (the listen socket). */
  deepgramKey?: string;
  /** ElevenLabs key: primary TTS engine. */
  elevenLabsKey?: string;
  /** Deepgram key for the Aura TTS fallback. server.ts passes DEEPGRAM_API_KEY here as well. */
  deepgramTtsKey?: string;
  voiceId?: string;
  modelId?: string;
  /** Demo chaos toggles from the /ws URL (`?fail=tool,tts,stt`). Off by default. */
  chaos?: ChaosFlag[];
  log?: (msg: string) => void;
  /** Test hook: build the agent from an injected factory instead of the real model. */
  createAgent?: (session: Session, onEvent: (e: AgentEvent) => void) => SupportAgent;
  /** Test hook: override RESUME_AFTER_BARGE_IN_MS. */
  resumeAfterBargeInMs?: number;
  /** Test hook: override TTS_ENGINE_COOLDOWN_MS. */
  ttsEngineCooldownMs?: number;
}

export type ClientMessage =
  | { type: "text"; text: string }
  | { type: "played"; turnId: string; t?: number }
  | { type: "reset" };

export type { SessionSnapshot };

export type ServerMessage =
  | {
      type: "ready";
      sessionId: string;
      voice: { stt: boolean; tts: boolean; ttsEngines: TtsVendor[] };
      chaos: ChaosFlag[];
    }
  | { type: "stt"; text: string; final: boolean }
  | { type: "agent_text"; turnId: string; delta: string }
  | {
      type: "tool";
      turnId: string;
      name: string;
      phase: "start" | "end" | "blocked";
      ms?: number;
      args?: unknown;
      detail?: string;
      error?: boolean;
    }
  | { type: "state"; session: SessionSnapshot }
  | { type: "clear_audio" }
  | LatencyReport
  | { type: "error"; message: string };

interface ToolRun {
  name: string;
  startedAt: number;
  toolLogLen: number;
}

interface Turn {
  id: string;
  source: TurnSource;
  /** What the customer said (or typed); re-sent when a barge-in produced no transcript. */
  userText: string;
  /** How many times this question has already been re-answered after silent barge-ins. */
  resumes: number;
  resumedFrom?: string;
  latency: TurnLatency;
  chunker: SentenceChunker;
  cancelled: boolean;
  spoke: boolean;
  fillerSent: boolean;
  fillerTimer?: NodeJS.Timeout;
  tools: Map<string, ToolRun>;
  tts?: TtsStream;
  /** Real failures per engine this turn; an engine is skipped at MAX_TTS_STREAMS_PER_ENGINE. */
  ttsFailures: Record<TtsVendor, number>;
  /** Engine that delivered the turn's first audio frame (what firstAudioMs measures). */
  firstAudioEngine: TtsEngineName;
  /** Every engine that delivered audio this turn, in order of first frame. */
  audioEngines: TtsVendor[];
  /** Every engine exhausted (or the loss is unrecoverable): TTS is off for the rest of the turn. */
  ttsFailed: boolean;
  ttsBytes: number;
  agentDone: boolean;
  ttsDone: boolean;
  finalized: boolean;
  logged: boolean;
  logTimer?: NodeJS.Timeout;
  text: string;
}

interface TurnMeta {
  resumedFrom?: string;
  resumes?: number;
}

/** The domain's own snapshot (so parked proposals and utteranceSeq reach the UI), toolLog trimmed. */
export function snapshotSession(session: Session): SessionSnapshot {
  return { ...session.snapshot(), toolLog: session.toolLog.slice(-30) };
}

function toBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export class VoiceSession {
  readonly id: string;
  private session!: Session;
  private support?: SupportAgent;
  private agentError?: string;
  private stt?: DeepgramStt;
  /** TTS engines in preference order (ElevenLabs, then Deepgram Aura). Empty = text only. */
  private readonly engines: TtsEngine[];
  private chaos: ChaosState;
  /** Engines resting after MAX_TTS_STREAMS_PER_ENGINE failures in one turn: name -> wall time the rest ends. */
  private engineDownUntil: Partial<Record<TtsVendor, number>> = {};
  private turn?: Turn;
  private readonly recentTurns = new Map<string, Turn>();
  private turnSeq = 0;
  private closed = false;
  private sttWarned = false;
  private sttErrorToasted = false;
  private sttAttempts = 0;
  private sttRetryAt = 0;
  private sttLastFailAt = 0;
  private lastInterimAt = 0;
  private resume?: { turn: Turn; at: number; timer: NodeJS.Timeout };
  private queue: Promise<void> = Promise.resolve();
  private readonly log: (msg: string) => void;

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: VoiceSessionOptions = {},
  ) {
    this.id = randomBytes(4).toString("hex");
    this.log = opts.log ?? ((m) => console.error(`[voice ${this.id}] ${m}`));
    this.chaos = new ChaosState(opts.chaos ?? []);
    const engines: TtsEngine[] = [];
    if (opts.elevenLabsKey) engines.push(new ElevenLabsTts(opts.elevenLabsKey, opts.voiceId));
    if (opts.deepgramTtsKey) engines.push(new DeepgramTts(opts.deepgramTtsKey));
    this.engines = engines;
    this.createAgent();

    this.ws.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    this.ws.on("close", () => this.close());
    this.ws.on("error", (err) => this.log(`client socket error: ${err.message}`));

    // The Deepgram socket is opened on the first mic frame, not here: an idle tab must not hold
    // a Deepgram connection, and a dropped socket is reopened on the next frame.
    this.send({
      type: "ready",
      sessionId: this.session.id,
      voice: { stt: !!opts.deepgramKey, tts: engines.length > 0, ttsEngines: engines.map((e) => e.name) },
      chaos: this.chaos.list,
    });
    this.send({ type: "state", session: snapshotSession(this.session) });
    if (this.agentError) this.send({ type: "error", message: `Agent unavailable: ${this.agentError}` });
  }

  // ---------------------------------------------------------------- wiring

  private createAgent(): void {
    this.session = new Session();
    this.agentError = undefined;
    try {
      this.support = this.opts.createAgent
        ? this.opts.createAgent(this.session, (e) => this.onAgentEvent(e))
        : createSupportAgent({
            session: this.session,
            modelId: this.opts.modelId,
            onEvent: (e) => this.onAgentEvent(e),
          });
      this.instrumentAgentTools();
    } catch (err) {
      this.support = undefined;
      this.agentError = err instanceof Error ? err.message : String(err);
      this.log(`createSupportAgent failed: ${this.agentError}`);
    }
  }

  /**
   * Wrap the agent's tool list (chaos fail=tool, and a failure text that names the tool).
   * Injected test agents without a tool list are left alone.
   */
  private instrumentAgentTools(): void {
    const agent = this.support?.agent;
    const tools = agent?.state?.tools;
    if (!agent || !Array.isArray(tools)) return;
    agent.state.tools = instrumentTools(tools, this.chaos);
  }

  /**
   * Make sure a Deepgram socket exists (or is connecting). Returns false while a reconnect
   * backoff is pending or after the attempts are exhausted (until the cooldown passes).
   */
  private ensureStt(key: string): boolean {
    if (this.stt) return true;
    const now = Date.now();
    if (this.sttAttempts >= STT_RECONNECT_BACKOFF_MS.length) {
      if (now - this.sttLastFailAt < STT_RECONNECT_COOLDOWN_MS) return false;
      this.sttAttempts = 0; // long quiet period: allow a fresh round of attempts
    }
    if (now < this.sttRetryAt) return false;
    this.openStt(key);
    return true;
  }

  private openStt(key: string): void {
    let inst: DeepgramStt | undefined;
    const attempt = this.sttAttempts;
    inst = new DeepgramStt(key, {
      onOpen: () => {
        if (this.stt !== inst) return;
        this.sttAttempts = 0;
        this.sttErrorToasted = false;
        this.log(attempt > 0 ? `deepgram open (reconnected after ${attempt} failure(s))` : "deepgram open");
      },
      onInterim: (text) => {
        if (this.stt !== inst) return;
        this.lastInterimAt = Date.now();
        this.send({ type: "stt", text, final: false });
      },
      onFinal: (text, meta) => {
        if (this.stt !== inst) return;
        const t0 = Date.now();
        const sttFinalMs = meta.speechEndWall === undefined ? 0 : Math.max(0, t0 - meta.speechEndWall);
        this.send({ type: "stt", text, final: true });
        this.onUserFinal(text, "voice", t0, sttFinalMs);
        if (this.chaos.takeSttDrop()) {
          // Simulated network drop: the socket goes away once, the reconnect path brings it back.
          this.log("chaos fail=stt: closing the Deepgram socket after the first final");
          this.send({
            type: "error",
            message: "Chaos fail=stt: speech recognition socket dropped; it reconnects on the next audio frame.",
          });
          inst!.close();
        }
      },
      onSpeechStarted: () => {
        if (this.stt !== inst) return;
        this.onSpeechStarted();
      },
      onError: (err) => {
        if (this.stt !== inst) return;
        this.log(`deepgram error: ${err.message}`);
        if (!this.sttErrorToasted) {
          this.sttErrorToasted = true;
          this.send({ type: "error", message: `Speech recognition error: ${err.message}` });
        }
      },
      onClose: (code, reason) => {
        if (this.stt !== inst) return;
        this.stt = undefined;
        if (this.closed) return;
        this.sttAttempts++;
        this.sttLastFailAt = Date.now();
        if (this.sttAttempts >= STT_RECONNECT_BACKOFF_MS.length) {
          this.log(`deepgram closed ${code} ${reason}; giving up after ${this.sttAttempts} attempts`);
          this.send({
            type: "error",
            message: `Speech recognition disconnected (${code}). Use the text input, or stop and start the mic in a minute.`,
          });
          return;
        }
        const wait = STT_RECONNECT_BACKOFF_MS[this.sttAttempts - 1];
        this.sttRetryAt = Date.now() + wait;
        this.log(`deepgram closed ${code} ${reason}; reconnecting on next audio after ${wait} ms`);
      },
    });
    this.stt = inst;
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      this.onAudio(toBuffer(data));
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      this.send({ type: "error", message: "Malformed JSON message" });
      return;
    }
    switch (msg?.type) {
      case "text": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) return;
        if (text.length > MAX_TEXT_CHARS) {
          this.send({ type: "error", message: `Message too long (${text.length} chars, max ${MAX_TEXT_CHARS}).` });
          return;
        }
        this.onUserFinal(text, "text", Date.now(), 0);
        return;
      }
      case "played":
        this.onPlayed(String(msg.turnId ?? ""), Date.now());
        return;
      case "reset":
        this.reset();
        return;
      default:
        this.send({ type: "error", message: `Unknown message type: ${String((msg as { type?: unknown })?.type)}` });
    }
  }

  private onAudio(pcm: Buffer): void {
    const key = this.opts.deepgramKey;
    if (!key) {
      if (!this.sttWarned) {
        this.sttWarned = true;
        this.send({ type: "error", message: "Voice input disabled: DEEPGRAM_API_KEY not set. Use the text input." });
      }
      return;
    }
    if (!this.ensureStt(key)) return; // backoff pending or attempts exhausted: frame dropped
    this.stt!.sendAudio(pcm);
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendAudio(pcm: Buffer): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(pcm, { binary: true });
  }

  // ---------------------------------------------------------------- turn lifecycle

  private onUserFinal(text: string, source: TurnSource, t0: number, sttFinalMs: number): void {
    this.clearResume(); // the customer did say something: no need to repeat the old answer
    const prev = this.turn;
    if (prev && !prev.finalized) this.cancelTurn(prev, "new user turn");
    else if (prev && this.isStillPlaying(prev)) {
      // Agent is idle but the client is still playing this turn's audio: cut it.
      this.send({ type: "clear_audio" });
    }
    this.startTurn(text, source, t0, sttFinalMs, {});
  }

  private startTurn(text: string, source: TurnSource, t0: number, sttFinalMs: number, meta: TurnMeta): void {
    this.queue = this.queue.then(() => this.runTurn(text, source, t0, sttFinalMs, meta)).catch((err) => {
      this.log(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async runTurn(text: string, source: TurnSource, t0: number, sttFinalMs: number, meta: TurnMeta): Promise<void> {
    if (this.closed) return;
    if (!this.support) {
      this.send({ type: "error", message: `Agent unavailable: ${this.agentError ?? "not configured"}` });
      return;
    }
    if (this.support.isBusy()) {
      this.support.abort();
      await this.support.agent.waitForIdle();
    }
    if (this.closed) return;

    const id = `t${++this.turnSeq}-${randomBytes(2).toString("hex")}`;
    const turn: Turn = {
      id,
      source,
      userText: text,
      resumes: meta.resumes ?? 0,
      resumedFrom: meta.resumedFrom,
      latency: new TurnLatency(id, source, t0, sttFinalMs),
      chunker: new SentenceChunker(),
      cancelled: false,
      spoke: false,
      fillerSent: false,
      tools: new Map(),
      ttsFailures: { elevenlabs: 0, deepgram: 0 },
      firstAudioEngine: "none",
      audioEngines: [],
      ttsFailed: false,
      ttsBytes: 0,
      agentDone: false,
      ttsDone: this.engines.length === 0,
      finalized: false,
      logged: false,
      text: "",
    };
    this.turn = turn;
    this.rememberTurn(turn);
    // Open the TTS socket now so its connect time hides behind the model's first token.
    if (this.engines.length > 0) turn.tts = this.openTtsStream(turn);

    try {
      await this.support.sendUserText(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`sendUserText error: ${message}`);
      if (!turn.cancelled) this.send({ type: "error", message: `Agent error: ${message}` });
    }
    // agent_end normally got here first; this is the safety net.
    if (!turn.agentDone) this.onAgentDone(turn);
  }

  private onAgentEvent(e: AgentEvent): void {
    const turn = this.turn;
    if (!turn) return;
    switch (e.type) {
      case "message_update": {
        if (turn.cancelled) return;
        if (e.assistantMessageEvent.type === "text_end") {
          // A text block is complete (typically right before a tool call): speak whatever is
          // buffered now instead of waiting for the next sentence boundary after the tools.
          this.flushChunker(turn);
          return;
        }
        if (e.assistantMessageEvent.type !== "text_delta") return;
        const delta = e.assistantMessageEvent.delta;
        if (!delta) return;
        turn.latency.markFirstToken();
        turn.text += delta;
        this.send({ type: "agent_text", turnId: turn.id, delta });
        for (const chunk of turn.chunker.push(delta)) this.speak(turn, chunk);
        return;
      }
      case "tool_execution_start": {
        this.flushChunker(turn); // fallback in case no text_end preceded the tool call
        turn.tools.set(e.toolCallId, {
          name: e.toolName,
          startedAt: Date.now(),
          toolLogLen: this.session.toolLog.length,
        });
        this.send({ type: "tool", turnId: turn.id, name: e.toolName, phase: "start", args: e.args });
        this.armFiller(turn);
        return;
      }
      case "tool_execution_end": {
        const run = turn.tools.get(e.toolCallId);
        turn.tools.delete(e.toolCallId);
        const ms = run ? Date.now() - run.startedAt : 0;
        turn.latency.addToolMs(ms);
        // The filler timer is deliberately not cleared here: the silence the customer hears is
        // the model round trip after the tool, so the filler stays armed until something is
        // spoken or the turn ends.
        const detail = resultText(e.result).slice(0, 400);
        // Blocked calls take the harness's "immediate" path and never reach afterToolCall, so
        // the guard's toolLog entry is missing. That absence (or an explicit `blocked` mark) is
        // how we tell "blocked by guard" from "executed and failed".
        const logLenAtStart = run?.toolLogLen ?? this.session.toolLog.length;
        const grew = this.session.toolLog.length > logLenAtStart;
        const last = grew ? this.session.toolLog[this.session.toolLog.length - 1] : undefined;
        const blocked = e.isError && (!grew || !!last?.blocked);
        // The tool did run and finish, so the end event and state are sent even for a cancelled
        // turn; only the user-facing error toast is skipped because the customer moved on. If the
        // turn was cancelled by a silent barge-in, the resume re-answers and the model announces
        // the result from its history.
        this.send({
          type: "tool",
          turnId: turn.id,
          name: e.toolName,
          phase: blocked ? "blocked" : "end",
          ms,
          detail,
          error: e.isError && !blocked ? true : undefined,
        });
        if (e.isError && !blocked && !turn.cancelled) {
          // The failure text the model reads already names the tool (instrumentTools); the
          // toast shows the same words. The harness feeds it back to the model and the turn
          // goes on: the next model round is where the apology / escalation offer comes from.
          const prefix = `Tool ${e.toolName} failed`;
          const message = detail.startsWith(prefix) ? detail : `${prefix}: ${detail || "unknown error"}`;
          this.send({ type: "error", message });
        }
        this.send({ type: "state", session: snapshotSession(this.session) });
        return;
      }
      case "agent_end": {
        const err = this.support?.agent.state.errorMessage;
        if (err && !turn.cancelled) {
          this.log(`agent error: ${err}`);
          this.send({ type: "error", message: `Model error: ${err}` });
        }
        this.onAgentDone(turn);
        return;
      }
      default:
        return;
    }
  }

  private onAgentDone(turn: Turn): void {
    if (turn.agentDone) return;
    turn.agentDone = true;
    this.clearFiller(turn);
    if (!turn.cancelled) {
      this.flushChunker(turn);
      this.send({ type: "state", session: snapshotSession(this.session) });
    }
    if (turn.tts && !turn.cancelled) {
      if (!turn.spoke) {
        // Pre-opened stream that never got text (e.g. model returned nothing): drop it quietly.
        turn.tts.cancel();
        turn.tts = undefined;
        turn.ttsDone = true;
      } else {
        // A stream caught in its close handshake cannot take the end-of-input: retire it first so
        // its undelivered sentences go out on a replacement, then flush whatever stream is left.
        if (!turn.tts.isAlive) this.retireStream(turn, turn.tts);
        if (turn.tts) turn.tts.flush();
        else turn.ttsDone = true; // retiring found nothing to replace it with; the toast went out
      }
    } else {
      turn.ttsDone = true;
    }
    this.maybeFinalize(turn);
  }

  private maybeFinalize(turn: Turn): void {
    if (turn.finalized || !turn.agentDone || !turn.ttsDone) return;
    turn.finalized = true;
    turn.latency.cancelled = turn.cancelled;
    turn.latency.ttsEngine = turn.ttsBytes > 0 ? turn.firstAudioEngine : "none";
    turn.latency.ttsEngines = turn.ttsBytes > 0 ? [...turn.audioEngines] : [];
    turn.latency.markEnd();
    const report = turn.latency.report();
    this.send(report);
    // stdout line: wait briefly for the client's `played` report when audio was sent.
    if (turn.latency.firstAudioAt === undefined || turn.latency.playedAt !== undefined) {
      this.writeLatencyLine(turn);
    } else {
      turn.logTimer = setTimeout(() => this.writeLatencyLine(turn), PLAYED_GRACE_MS);
    }
  }

  private writeLatencyLine(turn: Turn): void {
    if (turn.logged) return;
    turn.logged = true;
    if (turn.logTimer) {
      clearTimeout(turn.logTimer);
      turn.logTimer = undefined;
    }
    logLatencyLine(turn.latency.report(), {
      sessionId: this.session.id,
      audioMs: Math.round(pcmBytesToMs(turn.ttsBytes)),
      chars: turn.text.length,
      ...(turn.resumedFrom ? { resumedFrom: turn.resumedFrom } : {}),
    });
  }

  private onPlayed(turnId: string, at: number): void {
    const turn = this.recentTurns.get(turnId);
    if (!turn) return;
    turn.latency.markPlayed(at);
    // A late report only completes the stdout line. It is not re-sent as a latency event: the
    // client tags audio frames with the last turn id it saw, so an event for an old turn would
    // mislabel the next turn's audio.
    if (turn.finalized && !turn.logged) this.writeLatencyLine(turn);
  }

  private rememberTurn(turn: Turn): void {
    this.recentTurns.set(turn.id, turn);
    while (this.recentTurns.size > 8) {
      const oldest = this.recentTurns.keys().next().value as string;
      const old = this.recentTurns.get(oldest);
      if (old?.logTimer) clearTimeout(old.logTimer);
      this.recentTurns.delete(oldest);
    }
  }

  // ---------------------------------------------------------------- speech out

  private flushChunker(turn: Turn): void {
    if (turn.cancelled) return;
    const rest = turn.chunker.flush();
    if (rest) this.speak(turn, rest);
  }

  private speak(turn: Turn, text: string): void {
    if (turn.cancelled || turn.ttsFailed || this.engines.length === 0) return;
    // A stream that stopped being writable without reporting an error is in its close handshake
    // (close frame received, TCP close pending): text written to it would vanish, so retire it
    // through the failure path first. That may open the replacement or give up for the turn.
    if (turn.tts && !turn.tts.isAlive) this.retireStream(turn, turn.tts);
    if (turn.ttsFailed) return;
    if (!turn.tts) {
      const next = this.openTtsStream(turn);
      if (!next) {
        // Every engine is resting after repeated failures (or used up): text only for this turn.
        turn.ttsFailed = true;
        this.log(`tts unavailable (${turn.id}): ${this.describeEngines()}`);
        this.send({ type: "error", message: `Speech synthesis unavailable (${this.describeEngines()}); the answer continues as text.` });
        return;
      }
      turn.tts = next;
    }
    turn.tts.sendText(text);
    turn.spoke = true;
    this.clearFiller(turn);
  }

  /**
   * First engine that still has a stream left this turn and is not resting, in preference
   * order. A rest that has run out is lifted here, on the first pick after it.
   */
  private pickEngine(turn: Turn): TtsEngine | undefined {
    const now = Date.now();
    return this.engines.find((e) => {
      if (turn.ttsFailures[e.name] >= MAX_TTS_STREAMS_PER_ENGINE) return false;
      const downUntil = this.engineDownUntil[e.name];
      if (downUntil !== undefined) {
        if (now < downUntil) return false;
        delete this.engineDownUntil[e.name];
        this.log(`tts engine ${e.name} back in rotation`);
      }
      return true;
    });
  }

  /** Engine names with their rest state, for logs and the one toast a text-only turn gets. */
  private describeEngines(): string {
    const now = Date.now();
    return this.engines
      .map((e) => {
        const until = this.engineDownUntil[e.name];
        return until !== undefined && until > now ? `${e.name} resting ${Math.ceil((until - now) / 1000)} s after repeated failures` : e.name;
      })
      .join(", ");
  }

  /**
   * Rest an engine that used up its streams in one turn. The next turn pre-opens the next engine
   * directly instead of paying this one's connect-and-reject again; pickEngine lifts the rest.
   */
  private markEngineDown(engine: TtsVendor, turn: Turn, err: Error): void {
    const ms = this.opts.ttsEngineCooldownMs ?? TTS_ENGINE_COOLDOWN_MS;
    this.engineDownUntil[engine] = Date.now() + ms;
    this.log(
      `tts engine ${engine} down for ${Math.round(ms / 1000)} s: ${MAX_TTS_STREAMS_PER_ENGINE} failures in ${turn.id}, last "${err.message}"; later turns start on the next engine`,
    );
  }

  /**
   * `stream` received a close frame but its TCP close has not fired yet (ws sits in CLOSING
   * until the peer's FIN or its own 30 s timer), so it is not writable and has not reported an
   * error either. Text sent to it would be dropped on the floor and its close event would find
   * a different current stream and be ignored. So it is retired now through the ordinary
   * failure path (undelivered sentences re-sent, failure counted, replacement opened) and then
   * terminated, which silences its eventual close event and stops the socket lingering.
   */
  private retireStream(turn: Turn, stream: TtsStream): void {
    if (stream !== turn.tts || stream.cancelled) return;
    this.onTtsError(turn, stream, new Error(`${stream.engine} socket is closing (close frame received before the turn ended)`));
    stream.cancel();
  }

  /** Open a stream on the engine picked for this turn; undefined when every engine is used up. */
  private openTtsStream(turn: Turn): TtsStream | undefined {
    const engine = this.pickEngine(turn);
    if (!engine) return undefined;
    const events = {
      onAudio: (stream: TtsStream, pcm: Buffer) => {
        // Late chunks from a cancelled or superseded stream are dropped here, never forwarded.
        if (turn.cancelled || stream !== turn.tts || this.closed) return;
        turn.latency.markFirstAudio();
        turn.ttsBytes += pcm.length;
        if (turn.firstAudioEngine === "none") turn.firstAudioEngine = stream.engine;
        if (!turn.audioEngines.includes(stream.engine)) turn.audioEngines.push(stream.engine);
        this.sendAudio(pcm);
      },
      onEnd: (stream: TtsStream) => {
        if (stream !== turn.tts) return;
        turn.ttsDone = true;
        this.maybeFinalize(turn);
      },
      onError: (stream: TtsStream, err: Error) => this.onTtsError(turn, stream, err),
    };
    if (engine.name === "elevenlabs" && this.chaos.has("tts")) {
      // fail=tts: no ElevenLabs socket is opened; the stream fails on the next tick and the
      // ordinary retry / fallback path below carries the sentences to Aura.
      return new FailingTtsStream("elevenlabs", events, "chaos fail=tts");
    }
    return engine.openStream(events);
  }

  private onTtsError(turn: Turn, stream: TtsStream, err: Error): void {
    if (stream !== turn.tts) return;
    turn.tts = undefined;
    const settle = (): void => {
      if (turn.agentDone) {
        turn.ttsDone = true;
        this.maybeFinalize(turn);
      }
    };
    if (turn.cancelled || this.closed) {
      settle();
      return;
    }
    if (stream.idle) {
      // The pre-opened socket went away before the model said anything (inactivity timeout or
      // a blip). Nothing was lost; the next sentence opens a new socket. No toast, no failure.
      this.log(`tts idle close (${turn.id}, ${stream.engine}): ${err.message}`);
      settle();
      return;
    }
    turn.ttsFailures[stream.engine] += 1;
    this.log(
      `tts error (${turn.id}, ${stream.engine} stream ${stream.id}, failure ${turn.ttsFailures[stream.engine]}): ${err.message}`,
    );
    if (turn.ttsFailures[stream.engine] >= MAX_TTS_STREAMS_PER_ENGINE) this.markEngineDown(stream.engine, turn, err);
    const lost = stream.lostText;
    // A replacement only when it can help: there is text to re-send, or the model is still
    // talking so later sentences need a socket. `lostText` is every sentence the dead stream's
    // audio cannot have covered (biased toward repeating one rather than losing one); a flushed
    // stream whose audio covered everything lost at most the tail of its last sentence, which
    // cannot be re-sent. The replacement comes from the same engine while it has a stream
    // left, then from the next engine.
    const next = lost.length > 0 || !stream.flushWasRequested ? this.openTtsStream(turn) : undefined;
    if (next) {
      turn.tts = next;
      for (const t of lost) next.sendText(t);
      if (stream.flushWasRequested) next.flush();
      const kind = next.engine === stream.engine ? "retry" : "fallback";
      const note = lost.length === 0 && stream.textWasSent ? "; its audio covered every sentence written, at most the tail of the last one is cut" : "";
      this.log(`tts ${kind} (${turn.id}): ${next.engine} stream ${next.id}, re-sent ${lost.length} chunk(s)${note}`);
      return;
    }
    // Nothing left to try (or nothing recoverable): TTS is off for the rest of this turn. The
    // text keeps streaming to the client. One toast per turn, not one per sentence.
    turn.ttsFailed = true;
    this.send({ type: "error", message: `Speech synthesis error: ${err.message}` });
    settle();
  }

  /**
   * Voice turns only: a customer who typed is reading, there is no silence to fill. Armed when
   * a tool starts and nothing has been spoken this turn. It is NOT cleared when the tool ends:
   * in-memory tools finish in milliseconds and the silence the customer actually hears is the
   * model round trip afterwards. It fires 700 ms after the tool start unless something was
   * spoken, the model is already streaming its answer, or the turn ended.
   */
  private armFiller(turn: Turn): void {
    if (turn.source !== "voice" || this.engines.length === 0) return;
    if (turn.fillerSent || turn.spoke || turn.cancelled || turn.fillerTimer || turn.ttsFailed) return;
    const textLenAtArm = turn.text.length;
    turn.fillerTimer = setTimeout(() => {
      turn.fillerTimer = undefined;
      if (turn.cancelled || turn.spoke || turn.fillerSent || turn.agentDone) return;
      // The answer is already streaming: its first sentence is moments away, a filler would only delay it.
      if (turn.text.length > textLenAtArm) return;
      turn.fillerSent = true;
      this.send({ type: "agent_text", turnId: turn.id, delta: FILLER_TEXT + " " });
      this.speak(turn, FILLER_TEXT);
    }, FILLER_AFTER_MS);
  }

  private clearFiller(turn: Turn): void {
    if (turn.fillerTimer) {
      clearTimeout(turn.fillerTimer);
      turn.fillerTimer = undefined;
    }
  }

  /** True while the client is (estimated to be) still playing this turn's audio. */
  private isStillPlaying(turn: Turn): boolean {
    if (turn.cancelled || turn.ttsBytes === 0) return false;
    if (!turn.ttsDone) return true;
    const start = turn.latency.playedAt ?? turn.latency.firstAudioAt;
    if (start === undefined) return false;
    return Date.now() < start + pcmBytesToMs(turn.ttsBytes);
  }

  // ---------------------------------------------------------------- barge-in / resume / reset / close

  private onSpeechStarted(): void {
    const turn = this.turn;
    const generating = !!this.support?.isBusy();
    const speaking = !!turn && this.isStillPlaying(turn);
    if (!generating && !speaking) return;
    if (turn && !turn.finalized) {
      this.cancelTurn(turn, "barge-in");
      this.armResume(turn);
    } else {
      // The answer was fully generated and only its playback is cut: the text is on screen and
      // repeating the whole answer would be worse than losing its tail.
      if (generating) this.support?.abort();
      this.send({ type: "clear_audio" });
    }
  }

  /**
   * After a barge-in cancel, wait for the customer's transcript. If none arrives (and interims
   * are not still flowing) the interrupted question is answered again.
   */
  private armResume(turn: Turn): void {
    this.clearResume();
    if (!turn.userText) return;
    if (turn.resumes >= MAX_RESUMES) {
      this.log(`no resume for ${turn.id}: already re-answered ${turn.resumes} time(s)`);
      return;
    }
    const delay = this.opts.resumeAfterBargeInMs ?? RESUME_AFTER_BARGE_IN_MS;
    const at = Date.now();
    const check = (): void => {
      if (this.closed || this.resume?.turn !== turn || this.turn !== turn) {
        this.clearResume();
        return;
      }
      if (this.lastInterimAt > at && Date.now() - this.lastInterimAt < delay) {
        // The customer is actually talking (interims keep arriving): wait for their final.
        this.resume = { turn, at, timer: setTimeout(check, delay) };
        return;
      }
      this.resume = undefined;
      this.log(`resume ${turn.id}: barge-in produced no transcript, answering again`);
      this.startTurn(turn.userText, turn.source, Date.now(), 0, { resumedFrom: turn.id, resumes: turn.resumes + 1 });
    };
    this.resume = { turn, at, timer: setTimeout(check, delay) };
  }

  private clearResume(): void {
    if (this.resume) {
      clearTimeout(this.resume.timer);
      this.resume = undefined;
    }
  }

  private cancelTurn(turn: Turn, reason: string): void {
    if (turn.cancelled) {
      if (this.support?.isBusy()) this.support.abort();
      return;
    }
    this.log(`cancel ${turn.id} (${reason})`);
    turn.cancelled = true;
    this.clearFiller(turn);
    if (this.support?.isBusy()) this.support.abort();
    if (turn.tts) {
      turn.tts.cancel();
      turn.tts = undefined;
    }
    turn.ttsDone = true;
    this.send({ type: "clear_audio" });
    if (!this.support?.isBusy()) turn.agentDone = true;
    this.maybeFinalize(turn);
  }

  private reset(): void {
    this.clearResume();
    const prev = this.turn;
    if (prev && !prev.finalized) this.cancelTurn(prev, "reset");
    this.send({ type: "clear_audio" });
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        if (this.support?.isBusy()) {
          this.support.abort();
          await this.support.agent.waitForIdle();
        }
        this.turn = undefined;
        // A reset re-arms the one-shot chaos failures so the demo can be replayed on one tab,
        // and lifts any engine rest for the same reason.
        this.chaos = new ChaosState(this.opts.chaos ?? []);
        const resting = Object.keys(this.engineDownUntil);
        if (resting.length > 0) this.log(`tts engine rest lifted by reset: ${resting.join(", ")}`);
        this.engineDownUntil = {};
        this.createAgent();
        this.send({ type: "state", session: snapshotSession(this.session) });
        if (this.agentError) this.send({ type: "error", message: `Agent unavailable: ${this.agentError}` });
        this.log("session reset");
      })
      .catch((err) => this.log(`reset failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearResume();
    const turn = this.turn;
    if (turn && !turn.finalized) this.cancelTurn(turn, "client closed");
    for (const t of this.recentTurns.values()) {
      if (t.logTimer) {
        clearTimeout(t.logTimer);
        t.logTimer = undefined;
        if (t.finalized && !t.logged) this.writeLatencyLine(t);
      }
      if (t.tts) {
        t.tts.cancel();
        t.tts = undefined;
      }
    }
    if (this.support?.isBusy()) this.support.abort();
    const stt = this.stt;
    this.stt = undefined;
    stt?.close();
    try {
      if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close();
    } catch {
      /* ignore */
    }
    this.log("closed");
  }
}
