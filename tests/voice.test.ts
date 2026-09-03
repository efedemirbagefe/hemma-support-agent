/**
 * Voice pipeline tests without any vendor: a mock Deepgram listen socket (stamps words on its
 * own audio clock), a mock ElevenLabs stream-input socket, a mock Deepgram Aura speak socket, a
 * fake client socket and a scripted SupportAgent. No ANTHROPIC / DEEPGRAM / ELEVENLABS keys needed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { createSupportAgent, type SupportAgent } from "../src/agent/createAgent";
import { Session } from "../src/domain/session";
import { createTools } from "../src/domain/tools";
import { ChaosState, instrumentTools, parseChaos } from "../src/voice/chaos";
import { SentenceChunker } from "../src/voice/chunker";
import { DEEPGRAM_URL, DeepgramStt, deepgramListenUrl, describeSttModel } from "../src/voice/deepgram";
import { DEEPGRAM_TTS_MODEL, deepgramSpeakUrl } from "../src/voice/deepgram-tts";
import { ELEVENLABS_MODEL_ID, elevenLabsUrl } from "../src/voice/elevenlabs";
import { TurnLatency } from "../src/voice/latency";
import { FILLER_TEXT, FILLER_TEXTS, GREETINGS, VoiceSession, MAX_TEXT_CHARS, type ServerMessage } from "../src/voice/session-voice";
import { MS_PER_CHAR_FLOOR, lostChunks } from "../src/voice/tts";
import { vendorUrlOverride } from "../src/voice/vendor-url";

// ------------------------------------------------------------------ mocks

/** Deepgram stand-in: counts audio bytes so word timestamps live on the real audio clock, and keeps each socket's request URL (the model query). */
class MockDeepgram {
  readonly wss: WebSocketServer;
  readonly sockets: Array<{ ws: WebSocket; audioBytes: number; url: string }> = [];
  url = "";
  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on("connection", (ws, req) => {
      const entry = { ws, audioBytes: 0, url: req.url ?? "" };
      this.sockets.push(entry);
      ws.on("message", (data, isBinary) => {
        if (isBinary) entry.audioBytes += (data as Buffer).length;
      });
    });
  }
  async listening(): Promise<void> {
    if (this.wss.address()) return;
    await once(this.wss, "listening");
  }
  async start(): Promise<string> {
    await this.listening();
    this.url = `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/v1/listen`;
    return this.url;
  }
  async waitForSocket(n = 1): Promise<{ ws: WebSocket; audioBytes: number; url: string }> {
    for (let i = 0; i < 200 && this.sockets.length < n; i++) await sleep(10);
    assert.ok(this.sockets.length >= n, `mock deepgram: expected ${n} connection(s)`);
    return this.sockets[n - 1];
  }
  get last() {
    return this.sockets[this.sockets.length - 1];
  }
  speechStarted(): void {
    this.last.ws.send(JSON.stringify({ type: "SpeechStarted", timestamp: this.last.audioBytes / 32000 }));
  }
  interim(text: string): void {
    this.last.ws.send(
      JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: text }] } }),
    );
  }
  /** Final with speech_final; the last word ends `endOffsetMs` before the audio received so far. */
  final(text: string, endOffsetMs: number): void {
    const clockSec = this.last.audioBytes / 32000;
    const end = Math.max(0, clockSec - endOffsetMs / 1000);
    const words = text.split(" ").map((w, i, arr) => ({ word: w, start: end - (arr.length - i) * 0.2, end: end - (arr.length - i - 1) * 0.2 }));
    this.last.ws.send(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        start: 0,
        duration: end,
        channel: { alternatives: [{ transcript: text, words }] },
      }),
    );
  }
  close(): void {
    for (const s of this.sockets) s.ws.terminate();
    this.wss.close();
  }
}

/**
 * Audio a mock returns per text chunk: 60 ms per character, like a slow real voice and above the
 * 40 / 60 ms per character floors the client uses to decide what a dead stream delivered.
 */
const MOCK_MS_PER_CHAR = 60;
const mockAudioBytes = (text: string): number => text.length * MOCK_MS_PER_CHAR * 32;

/**
 * ElevenLabs stand-in: answers every text chunk with audio sized like real speech, isFinal on
 * flush. Per-connection failure modes: rejected at init, a close frame with no FIN after the
 * first chunk (the client sits in CLOSING), audio for the first chunk then an error on the second.
 */
class MockElevenLabs {
  readonly wss: WebSocketServer;
  connections = 0;
  /** Connections (1-based) that answer the init message with an API error. */
  failConnections = new Set<number>();
  /**
   * Connections that answer their first text chunk with a close frame (no error JSON) and never
   * send the TCP FIN: the client stays in CLOSING until it terminates the socket itself, which
   * is what a vendor-side restart or proxy teardown looks like over a real RTT.
   */
  closingConnections = new Set<number>();
  /** Connections that deliver audio for their first chunk and answer the second with an API error. */
  dieOnSecondChunk = new Set<number>();
  readonly received: string[] = [];
  /** Text chunks per connection (1-based), so a test can see what each socket got. */
  readonly receivedBy = new Map<number, string[]>();
  /** Server-side sockets per connection, to check the client really closed one. */
  readonly sockets = new Map<number, WebSocket>();
  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on("connection", (ws) => {
      const n = ++this.connections;
      this.receivedBy.set(n, []);
      this.sockets.set(n, ws);
      let failed = false;
      let chunks = 0;
      ws.on("message", (data) => {
        if (failed) return; // a rejected stream ignores whatever else the client wrote
        const msg = JSON.parse(data.toString());
        if (typeof msg.text !== "string") return;
        if (msg.voice_settings) {
          if (this.failConnections.has(n)) {
            failed = true;
            ws.send(JSON.stringify({ error: "invalid_api_key", message: "invalid api key", code: 1008 }));
            ws.close(1008, "invalid api key");
          }
          return;
        }
        if (msg.text === "") {
          ws.send(JSON.stringify({ audio: Buffer.alloc(320).toString("base64"), isFinal: false }));
          ws.send(JSON.stringify({ isFinal: true }));
          ws.close(1000);
          return;
        }
        chunks++;
        this.received.push(msg.text.trim());
        this.receivedBy.get(n)!.push(msg.text.trim());
        if (this.closingConnections.has(n)) {
          failed = true;
          (ws as unknown as { _socket: { end: () => void } })._socket.end = () => {};
          ws.close(1011, "server going away");
          return;
        }
        if (this.dieOnSecondChunk.has(n) && chunks === 2) {
          failed = true;
          ws.send(JSON.stringify({ error: "system_busy", message: "system busy", code: 1011 }));
          ws.close(1011, "busy");
          return;
        }
        ws.send(JSON.stringify({ audio: Buffer.alloc(mockAudioBytes(msg.text)).toString("base64"), isFinal: false }));
      });
    });
  }
  async start(): Promise<string> {
    if (!this.wss.address()) await once(this.wss, "listening");
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
  close(): void {
    for (const ws of this.sockets.values()) ws.terminate();
    this.wss.close();
  }
}

/**
 * Deepgram Aura speak stand-in (contract as verified live, see deepgram-tts.ts): Metadata on
 * connect, a raw PCM frame per Speak, one more frame plus Flushed per Flush, close 1000 on Close.
 */
class MockAura {
  readonly wss: WebSocketServer;
  connections = 0;
  /** Connections (1-based) that answer with an Error message and close. */
  failConnections = new Set<number>();
  readonly received: string[] = [];
  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on("connection", (ws) => {
      const n = ++this.connections;
      let seq = 0;
      ws.send(JSON.stringify({ type: "Metadata", request_id: `req-${n}`, model_name: "aura-2-thalia-en" }));
      if (this.failConnections.has(n)) {
        ws.send(JSON.stringify({ type: "Error", description: "invalid api key", code: "INVALID_AUTH" }));
        ws.close(1008, "invalid api key");
        return;
      }
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === "Speak" && typeof msg.text === "string") {
          this.received.push(msg.text.trim());
          ws.send(Buffer.alloc(640), { binary: true });
        } else if (msg.type === "Flush") {
          ws.send(Buffer.alloc(320), { binary: true });
          ws.send(JSON.stringify({ type: "Flushed", sequence_id: seq++ }));
        } else if (msg.type === "Close") {
          ws.close(1000);
        }
      });
    });
  }
  async start(): Promise<string> {
    if (!this.wss.address()) await once(this.wss, "listening");
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
  close(): void {
    this.wss.close();
  }
}

/** The browser's socket as seen from VoiceSession. */
class FakeClientWs extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  readonly messages: ServerMessage[] = [];
  audioBytes = 0;
  send(data: string | Buffer, opts?: { binary?: boolean }): void {
    if (opts?.binary || Buffer.isBuffer(data)) this.audioBytes += (data as Buffer).length;
    else this.messages.push(JSON.parse(data as string));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  clientJson(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
  clientAudio(ms: number): void {
    this.emit("message", Buffer.alloc(ms * 32), true);
  }
  ofType<T extends ServerMessage["type"]>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((m) => m.type === type) as Array<Extract<ServerMessage, { type: T }>>;
  }
  errors(): string[] {
    return this.ofType("error").map((e) => e.message);
  }
}

type Emit = (e: AgentEvent) => void;
type Script = (emit: Emit, signal: AbortSignal, text: string, session: Session) => Promise<void>;

/** Scripted SupportAgent: `script` drives the events for each sendUserText; `seeded` records addAssistantMessage. */
function fakeAgentFactory(script: Script) {
  const calls: string[] = [];
  const seeded: string[] = [];
  const factory = (session: Session, onEvent: Emit): SupportAgent => {
    let streaming = false;
    let controller: AbortController | undefined;
    let idle: Promise<void> = Promise.resolve();
    const agent = {
      state: { isStreaming: false, errorMessage: undefined as string | undefined },
      waitForIdle: () => idle,
    };
    return {
      agent: agent as unknown as SupportAgent["agent"],
      async sendUserText(text: string) {
        calls.push(text);
        streaming = true;
        agent.state.isStreaming = true;
        controller = new AbortController();
        idle = (async () => {
          try {
            await script(onEvent, controller.signal, text, session);
          } finally {
            streaming = false;
            agent.state.isStreaming = false;
            onEvent({ type: "agent_end", messages: [] } as unknown as AgentEvent);
          }
        })();
        await idle;
      },
      abort() {
        controller?.abort();
      },
      isBusy() {
        return streaming;
      },
      addAssistantMessage(text: string) {
        seeded.push(text);
      },
    };
  };
  return { factory, calls, seeded };
}

const delta = (text: string): AgentEvent =>
  ({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: {} } }) as unknown as AgentEvent;
const toolStart = (id: string, name: string): AgentEvent =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }) as unknown as AgentEvent;
const toolEnd = (id: string, name: string): AgentEvent =>
  ({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: "{}" }] }, isError: false }) as unknown as AgentEvent;

/** Abortable sleep. */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    await sleep(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

const dg = new MockDeepgram();
const el = new MockElevenLabs();
const aura = new MockAura();
before(async () => {
  process.env.DEEPGRAM_WS_URL = await dg.start();
  process.env.ELEVENLABS_WS_URL = await el.start();
  process.env.DEEPGRAM_SPEAK_WS_URL = await aura.start();
});
after(() => {
  dg.close();
  el.close();
  aura.close();
});

// ------------------------------------------------------------------ chunker

test("chunker: numbered lists and abbreviations are not sentence ends", () => {
  const c = new SentenceChunker();
  const out = c.push("Here are your options: 1. Replacement, 2. Refund of EUR 45. Which one? e.g. the vase set. Ok.");
  const rest = c.flush();
  assert.deepEqual(out, ["Here are your options: 1. Replacement, 2. Refund of EUR 45.", "Which one?", "e.g. the vase set."]);
  assert.equal(rest, "Ok.");
});

test("chunker: plain sentences, decimals and list at buffer start", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("It costs 3.5 EUR. 1. First, 2. Second. Done! "), ["It costs 3.5 EUR.", "1. First, 2. Second.", "Done!"]);
  assert.equal(c.flush(), undefined);
  const d = new SentenceChunker();
  assert.deepEqual(d.push("You have 2. "), ["You have 2."]);
});

// ------------------------------------------------------------------ deepgram anchor

test("deepgram: sttFinalMs stays small after a gap in the mic stream", async () => {
  const finals: number[] = [];
  const stt = new DeepgramStt("test-key", {
    onInterim: () => {},
    onFinal: (_text, meta) => finals.push(meta.speechEndWall === undefined ? -1 : Date.now() - meta.speechEndWall),
    onSpeechStarted: () => {},
    onError: (err) => assert.fail(`deepgram error ${err.message}`),
    onClose: () => {},
  });
  const sock = await dg.waitForSocket(1);
  for (let i = 0; i < 200 && !stt.isOpen; i++) await sleep(5);
  assert.ok(stt.isOpen);

  const frame = Buffer.alloc(100 * 32); // 100 ms
  for (let i = 0; i < 10; i++) {
    stt.sendAudio(frame);
    await sleep(100);
  }
  await sleep(30);
  assert.equal(sock.audioBytes, 10 * frame.length);
  dg.final("where is my order", 100); // speech ended 100 ms before the last frame
  for (let i = 0; i < 100 && finals.length < 1; i++) await sleep(10);
  assert.equal(finals.length, 1);
  assert.ok(finals[0] >= 50 && finals[0] <= 400, `first sttFinalMs ${finals[0]}`);

  await sleep(700); // mic paused: no audio, wall clock advances
  for (let i = 0; i < 5; i++) {
    stt.sendAudio(frame);
    await sleep(100);
  }
  await sleep(30);
  dg.final("and the lamp", 100);
  for (let i = 0; i < 100 && finals.length < 2; i++) await sleep(10);
  assert.equal(finals.length, 2);
  assert.ok(finals[1] >= 50 && finals[1] <= 400, `second sttFinalMs ${finals[1]} (gap must not inflate it)`);
  stt.close();
});

test("deepgram: audio sent while connecting is buffered and flushed on open", async () => {
  const stt = new DeepgramStt("test-key", {
    onInterim: () => {},
    onFinal: () => {},
    onSpeechStarted: () => {},
    onError: () => {},
    onClose: () => {},
  });
  assert.ok(stt.isConnecting);
  assert.equal(stt.sendAudio(Buffer.alloc(640)), true);
  assert.equal(stt.sendAudio(Buffer.alloc(640)), true);
  const sock = await dg.waitForSocket(2);
  for (let i = 0; i < 200 && sock.audioBytes < 1280; i++) await sleep(5);
  assert.equal(sock.audioBytes, 1280);
  assert.equal(stt.droppedFrames, 0);
  assert.equal(stt.audioSentMs, 40);
  stt.close();
});

// ------------------------------------------------------------------ session: barge-in resume

test("session: a barge-in with no transcript re-answers the interrupted question", async () => {
  const { factory, calls } = fakeAgentFactory(async (emit, signal) => {
    emit(delta("Your order HM-1042 is "));
    if (!(await pause(400, signal))) return;
    emit(delta("scheduled for Tuesday. "));
  });
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    deepgramKey: "test-key",
    createAgent: factory,
    resumeAfterBargeInMs: 200,
    log: () => {},
  });
  const socketsBefore = dg.sockets.length;
  ws.clientAudio(20); // first mic frame opens the Deepgram socket
  await dg.waitForSocket(socketsBefore + 1);
  ws.clientJson({ type: "text", text: "where is my order" });
  await sleep(80);
  assert.deepEqual(calls, ["where is my order"]);
  dg.speechStarted(); // cough: VAD fires, nothing transcribed
  await sleep(80);
  assert.equal(ws.ofType("clear_audio").length, 1, "barge-in cut the audio");
  assert.equal(calls.length, 1);
  await sleep(600); // resume window (200 ms) + second answer
  assert.deepEqual(calls, ["where is my order", "where is my order"], "question answered again");
  const turnIds = new Set(ws.ofType("agent_text").map((m) => m.turnId));
  assert.equal(turnIds.size, 2, "the resume is a new turn");
  const latency = ws.ofType("latency");
  assert.ok(latency.some((l) => l.cancelled), "the interrupted turn is reported cancelled");
  assert.ok(latency.some((l) => !l.cancelled && l.firstTokenMs !== null), "the resumed turn completed");
  vs.close();
});

test("session: no resume when the customer really did speak", async () => {
  const { factory, calls } = fakeAgentFactory(async (emit, signal) => {
    emit(delta("Your order HM-1042 is "));
    if (!(await pause(400, signal))) return;
    emit(delta("scheduled for Tuesday. "));
  });
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    deepgramKey: "test-key",
    createAgent: factory,
    resumeAfterBargeInMs: 200,
    log: () => {},
  });
  const socketsBefore = dg.sockets.length;
  ws.clientAudio(20);
  await dg.waitForSocket(socketsBefore + 1);
  ws.clientJson({ type: "text", text: "where is my order" });
  await sleep(80);
  dg.speechStarted();
  await sleep(50);
  dg.interim("actually");
  await sleep(150);
  dg.interim("actually cancel");
  await sleep(150); // past the 200 ms window, but interims are flowing: still waiting
  assert.equal(calls.length, 1, "interims keep the resume on hold");
  dg.final("actually cancel it", 50);
  await sleep(500);
  assert.deepEqual(calls, ["where is my order", "actually cancel it"]);
  vs.close();
});

// ------------------------------------------------------------------ session: text cap

test("session: oversized text is rejected without reaching the model", async () => {
  const { factory, calls } = fakeAgentFactory(async (emit) => {
    emit(delta("ok. "));
  });
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, { createAgent: factory, log: () => {} });
  ws.clientJson({ type: "text", text: "x".repeat(MAX_TEXT_CHARS + 1) });
  await sleep(30);
  assert.deepEqual(calls, []);
  assert.ok(ws.errors().some((m) => m.includes("too long")));
  vs.close();
});

// ------------------------------------------------------------------ session: filler and TTS

/** A tool call, then a slow model round trip with nothing spoken: the filler's case. */
const slowToolScript = async (emit: Emit, signal: AbortSignal): Promise<void> => {
  emit(toolStart("c1", "find_customer"));
  await pause(10, signal);
  emit(toolEnd("c1", "find_customer"));
  if (!(await pause(1000, signal))) return; // slow second model round trip, nothing spoken
  emit(delta("Found it. "));
};

test("session: on a voice turn the filler covers the model round trip after a fast tool", async () => {
  const { factory } = fakeAgentFactory(slowToolScript);
  const ws = new FakeClientWs();
  const receivedBefore = el.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    deepgramKey: "test-key",
    elevenLabsKey: "el-key",
    createAgent: factory,
    log: () => {},
  });
  const socketsBefore = dg.sockets.length;
  ws.clientAudio(20);
  await dg.waitForSocket(socketsBefore + 1);
  await sleep(30);
  dg.final("reschedule HM-1042", 10); // a spoken turn: source is voice
  await sleep(1300);
  const latency = ws.ofType("latency");
  assert.equal(latency[0]?.source, "voice");
  const texts = ws.ofType("agent_text").map((m) => m.delta);
  assert.equal(texts[0], FILLER_TEXT + " ", `filler spoken first, got ${JSON.stringify(texts)}`);
  assert.ok(el.received.slice(receivedBefore).includes(FILLER_TEXT), "filler reached TTS");
  assert.ok(ws.audioBytes > 0, "audio forwarded to the client");
  assert.equal(latency[0]?.ttsEngine, "elevenlabs");
  vs.close();
});

test("session: a text turn never gets the filler", async () => {
  const { factory } = fakeAgentFactory(slowToolScript);
  const ws = new FakeClientWs();
  const receivedBefore = el.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, { elevenLabsKey: "el-key", createAgent: factory, log: () => {} });
  ws.clientJson({ type: "text", text: "reschedule HM-1042" });
  await sleep(1300);
  const texts = ws.ofType("agent_text").map((m) => m.delta);
  assert.deepEqual(texts, ["Found it. "], `no filler on a typed turn, got ${JSON.stringify(texts)}`);
  assert.deepEqual(el.received.slice(receivedBefore), ["Found it."], "only the answer reached TTS");
  assert.equal(ws.ofType("latency")[0]?.source, "text");
  vs.close();
});

test("session: TTS failure gives one toast per turn and does not stop the text", async () => {
  const { factory } = fakeAgentFactory(async (emit, signal) => {
    emit(delta("First sentence. "));
    await pause(50, signal);
    emit(delta("Second sentence. "));
    await pause(50, signal);
    emit(delta("Third sentence. "));
  });
  const ws = new FakeClientWs();
  const first = el.connections + 1;
  el.failConnections.add(first);
  el.failConnections.add(first + 1);
  const vs = new VoiceSession(ws as unknown as WebSocket, { elevenLabsKey: "el-key", createAgent: factory, log: () => {} });
  ws.clientJson({ type: "text", text: "tell me three things" });
  await sleep(600);
  const toasts = ws.errors().filter((m) => m.startsWith("Speech synthesis error"));
  assert.equal(toasts.length, 1, `one toast, got ${JSON.stringify(ws.errors())}`);
  assert.equal(ws.ofType("agent_text").map((m) => m.delta).join(""), "First sentence. Second sentence. Third sentence. ");
  assert.equal(el.connections, first + 1, "no further sockets after TTS gave up for the turn");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1, "turn finalized despite TTS failure");
  assert.equal(latency[0].ttsEngine, "none");
  vs.close();
});

test("session: with both engines failing twice, one toast and ttsEngine none", async () => {
  const { factory } = fakeAgentFactory(async (emit, signal) => {
    emit(delta("First sentence. "));
    await pause(50, signal);
    emit(delta("Second sentence. "));
  });
  const ws = new FakeClientWs();
  const firstEl = el.connections + 1;
  el.failConnections.add(firstEl);
  el.failConnections.add(firstEl + 1);
  const firstAura = aura.connections + 1;
  aura.failConnections.add(firstAura);
  aura.failConnections.add(firstAura + 1);
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: factory,
    log: () => {},
  });
  ws.clientJson({ type: "text", text: "tell me two things" });
  await sleep(700);
  assert.equal(ws.errors().filter((m) => m.startsWith("Speech synthesis error")).length, 1, `got ${JSON.stringify(ws.errors())}`);
  assert.equal(el.connections, firstEl + 1, "two ElevenLabs streams");
  assert.equal(aura.connections, firstAura + 1, "two Aura streams");
  assert.equal(ws.audioBytes, 0);
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1);
  assert.equal(latency[0].ttsEngine, "none");
  vs.close();
});

test("session: a transient TTS failure is retried with the unsent sentences", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Alpha one. Beta two. "));
  });
  const ws = new FakeClientWs();
  const failing = el.connections + 1;
  el.failConnections.add(failing);
  const receivedBefore = el.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, { elevenLabsKey: "el-key", createAgent: factory, log: () => {} });
  ws.clientJson({ type: "text", text: "say two things" });
  await sleep(500);
  assert.deepEqual(el.received.slice(receivedBefore), ["Alpha one.", "Beta two."], "both sentences reached the replacement socket");
  assert.equal(ws.errors().filter((m) => m.startsWith("Speech synthesis error")).length, 0, "silent recovery");
  assert.ok(ws.audioBytes > 0);
  vs.close();
});

// ------------------------------------------------------------------ session: TTS fallback

test("session: after two ElevenLabs failures the turn falls back to Aura with the unsent sentences", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Alpha one. Beta two. "));
  });
  const ws = new FakeClientWs();
  const firstEl = el.connections + 1;
  el.failConnections.add(firstEl);
  el.failConnections.add(firstEl + 1);
  const auraConnBefore = aura.connections;
  const auraBefore = aura.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: factory,
    log: () => {},
  });
  ws.clientJson({ type: "text", text: "say two things" });
  await sleep(600);
  assert.deepEqual(aura.received.slice(auraBefore), ["Alpha one.", "Beta two."], "both sentences reached Aura");
  assert.equal(el.connections, firstEl + 1, "ElevenLabs was tried twice, not more");
  assert.equal(aura.connections, auraConnBefore + 1, "one Aura stream");
  assert.equal(ws.errors().filter((m) => m.startsWith("Speech synthesis error")).length, 0, "silent recovery");
  assert.ok(ws.audioBytes > 0, "Aura audio reached the client");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1);
  assert.equal(latency[0].ttsEngine, "deepgram");
  assert.ok(latency[0].firstAudioMs !== null);
  vs.close();
});

test("session: Aura alone (no ElevenLabs key) speaks every sentence and drains on Flushed", async () => {
  const { factory } = fakeAgentFactory(async (emit, signal) => {
    emit(delta("Your order ships Friday. "));
    await pause(30, signal);
    emit(delta("Anything else"));
  });
  const ws = new FakeClientWs();
  const auraBefore = aura.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, { deepgramTtsKey: "dg-key", createAgent: factory, log: () => {} });
  const ready = ws.ofType("ready")[0];
  assert.deepEqual(ready.voice, { stt: false, tts: true, ttsEngines: ["deepgram"] });
  ws.clientJson({ type: "text", text: "when does it ship" });
  await sleep(400);
  assert.deepEqual(aura.received.slice(auraBefore), ["Your order ships Friday.", "Anything else"]);
  assert.equal(ws.audioBytes, 640 * 2 + 320, "a frame per Speak plus the Flush frame");
  assert.equal(ws.ofType("latency")[0]?.ttsEngine, "deepgram");
  vs.close();
});

// ------------------------------------------------------------------ chaos toggles

test("chaos: parseChaos accepts a comma list, drops unknown and duplicate flags, keeps canonical order", () => {
  assert.deepEqual(parseChaos(null), []);
  assert.deepEqual(parseChaos(""), []);
  assert.deepEqual(parseChaos("tool"), ["tool"]);
  assert.deepEqual(parseChaos(" STT , bogus,tts,tts "), ["tts", "stt"]);
  assert.deepEqual(parseChaos("tts,tool,stt"), ["tool", "tts", "stt"]);
});

test("chaos: fail=tool makes check_resolution_options throw once through the domain's own hook", async () => {
  const signal = new AbortController().signal;
  const session = new Session();
  const tools = instrumentTools(createTools(session), new ChaosState(["tool"]));
  const find = tools.find((t) => t.name === "find_customer")!;
  const check = tools.find((t) => t.name === "check_resolution_options")!;
  const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content[0].text ?? "";
  const found = await find.execute("c0", { customerRef: "HM-2201" }, signal, () => {});
  assert.equal(JSON.parse(text(found)).found, true, "other tools are untouched");
  await assert.rejects(
    check.execute("c1", { orderId: "HM-0977", issue: "damaged" }, signal, () => {}),
    /^Error: Tool check_resolution_options failed: Simulated failure in check_resolution_options$/,
  );
  const second = await check.execute("c2", { orderId: "HM-0977", issue: "damaged" }, signal, () => {});
  assert.equal(JSON.parse(text(second)).found, true, "the second call succeeds");
  const third = await check.execute("c3", { orderId: "HM-1042", issue: "reschedule" }, signal, () => {});
  assert.equal(JSON.parse(text(third)).found, true, "and stays healthy");

  // Without the flag the wrapper only rewrites real failures.
  const plain = instrumentTools(createTools(new Session()), new ChaosState([]));
  const ok = await plain.find((t) => t.name === "check_resolution_options")!.execute("c4", { orderId: "HM-0977", issue: "damaged" }, signal, () => {});
  assert.equal(JSON.parse(text(ok)).found, true);
  const real = await plain
    .find((t) => t.name === "get_order")!
    .execute("c5", { orderId: "HM-1042", simulateFailure: true }, signal, () => {})
    .then(
      () => "resolved",
      (err: Error) => err.message,
    );
  assert.equal(real, "Tool get_order failed: Simulated failure in get_order");
});

// ------------------------------------------------------------------ pi stand-in (real Agent, scripted model)

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

interface ScriptStep {
  tools?: Array<{ name: string; args: Record<string, unknown> }>;
  text?: string;
}

/** Scripted pi streamFn (same shape as tests/agent-fake.test.ts): each step answers one model call. */
function scriptedStreamFn(steps: ScriptStep[]) {
  const calls: Context[] = [];
  let callId = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const streamFn: StreamFn = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    calls.push(context);
    void (async () => {
      const step = steps.shift();
      if (!step) return stream.push({ type: "error", reason: "error", error: assistantMessage([], "error", "script exhausted") });
      const content: AssistantMessage["content"] = [];
      const partial = () => assistantMessage([...content], "pending");
      stream.push({ type: "start", partial: partial() });
      await tick();
      if (step.text !== undefined) {
        const block: TextContent = { type: "text", text: "" };
        content.push(block);
        const idx = content.length - 1;
        stream.push({ type: "text_start", contentIndex: idx, partial: partial() });
        block.text = step.text;
        stream.push({ type: "text_delta", contentIndex: idx, delta: step.text, partial: partial() });
        stream.push({ type: "text_end", contentIndex: idx, content: step.text, partial: partial() });
        await tick();
      }
      for (const call of step.tools ?? []) {
        stream.push({ type: "toolcall_start", contentIndex: content.length, partial: partial() });
        const toolCall: ToolCall = { type: "toolCall", id: `call-${++callId}`, name: call.name, arguments: call.args };
        content.push(toolCall);
        stream.push({ type: "toolcall_end", contentIndex: content.length - 1, toolCall, partial: partial() });
        await tick();
      }
      const reason = (step.tools?.length ?? 0) > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason, message: assistantMessage([...content], reason) });
    })();
    return stream;
  };
  return { streamFn, calls };
}

test("chaos: fail=tool reaches the model through pi's real Agent (state.tools setter) and the toast shows the same text", async () => {
  const failureText = "Tool check_resolution_options failed: Simulated failure in check_resolution_options";
  const script = scriptedStreamFn([
    { tools: [{ name: "check_resolution_options", args: { orderId: "HM-0977", issue: "damaged" } }] },
    { text: "Sorry, that did not work. Shall I escalate it?" },
  ]);
  const ws = new FakeClientWs();
  let domainSession: Session | undefined;
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    chaos: ["tool"],
    log: () => {},
    // The real factory: pi's Agent with createTools(session); VoiceSession then assigns
    // agent.state.tools = instrumentTools(...), which is the wiring under test.
    createAgent: (session, onEvent) => {
      domainSession = session;
      return createSupportAgent({ session, streamFn: script.streamFn, onEvent });
    },
  });
  assert.deepEqual(ws.ofType("ready")[0].chaos, ["tool"]);
  ws.clientJson({ type: "text", text: "what can you do about the lamp" });
  for (let i = 0; i < 300 && ws.ofType("latency").length === 0; i++) await sleep(10);
  const tool = ws.ofType("tool");
  assert.equal(tool.length, 2, JSON.stringify(tool));
  assert.equal(tool[0].phase, "start");
  assert.equal(tool[0].name, "check_resolution_options");
  assert.equal(tool[1].phase, "end", "executed and failed, not blocked by a guard");
  assert.equal(tool[1].error, true);
  assert.equal(tool[1].detail, failureText);
  assert.deepEqual(ws.errors(), [failureText], "one toast, the words the model reads");
  // The model got the same words back as an error tool result on its next request.
  const next = script.calls[1];
  assert.ok(next, "the run continued to a second model call");
  const lastToolResult = [...next.messages].reverse().find((m) => m.role === "toolResult");
  assert.ok(lastToolResult && lastToolResult.role === "toolResult");
  assert.equal(lastToolResult.isError, true);
  assert.equal((lastToolResult.content[0] as TextContent).text, failureText);
  assert.equal(ws.ofType("agent_text").map((m) => m.delta).join(""), "Sorry, that did not work. Shall I escalate it?");
  assert.ok(domainSession?.toolLog.some((l) => l.tool === "check_resolution_options" && !l.ok), "the domain's afterToolCall logged the failed run");
  assert.equal(ws.ofType("latency")[0]?.cancelled, false);
  vs.close();
});

test("chaos: fail=tts skips ElevenLabs without opening a socket and speaks through Aura", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Chaos sentence. "));
  });
  const ws = new FakeClientWs();
  const elBefore = el.connections;
  const auraBefore = aura.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    chaos: ["tts"],
    createAgent: factory,
    log: () => {},
  });
  const ready = ws.ofType("ready")[0];
  assert.deepEqual(ready.chaos, ["tts"]);
  assert.deepEqual(ready.voice, { stt: false, tts: true, ttsEngines: ["elevenlabs", "deepgram"] });
  ws.clientJson({ type: "text", text: "hello" });
  await sleep(400);
  assert.equal(el.connections, elBefore, "no ElevenLabs socket was opened");
  assert.deepEqual(aura.received.slice(auraBefore), ["Chaos sentence."]);
  assert.equal(ws.errors().length, 0, "the fallback is silent");
  assert.equal(ws.ofType("latency")[0]?.ttsEngine, "deepgram");
  vs.close();
});

test("chaos: fail=stt drops the Deepgram socket once after the first final and it reconnects", async () => {
  const { factory, calls } = fakeAgentFactory(async (emit) => {
    emit(delta("ok. "));
  });
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    deepgramKey: "test-key",
    chaos: ["stt"],
    createAgent: factory,
    log: () => {},
  });
  assert.deepEqual(ws.ofType("ready")[0].chaos, ["stt"]);
  const before = dg.sockets.length;
  ws.clientAudio(20);
  const s1 = await dg.waitForSocket(before + 1);
  await sleep(30);
  dg.final("where is my order", 10);
  await sleep(150);
  assert.deepEqual(calls, ["where is my order"], "the first final still becomes a turn");
  assert.ok(ws.errors().some((m) => m.includes("fail=stt")), "the drop is announced once");
  for (let i = 0; i < 150 && s1.ws.readyState !== WebSocket.CLOSED; i++) await sleep(10);
  assert.equal(s1.ws.readyState, WebSocket.CLOSED, "the server closed its Deepgram socket");
  ws.clientAudio(20); // inside the 500 ms backoff: dropped, no new socket
  await sleep(20);
  assert.equal(dg.sockets.length, before + 1);
  await sleep(550);
  ws.clientAudio(20); // backoff over: reopened on the next frame
  const s2 = await dg.waitForSocket(before + 2);
  await sleep(30);
  dg.final("and the lamp", 10);
  await sleep(150);
  assert.deepEqual(calls, ["where is my order", "and the lamp"]);
  assert.equal(s2.ws.readyState, WebSocket.OPEN, "dropped only once");
  assert.equal(ws.errors().filter((m) => m.includes("fail=stt")).length, 1);
  vs.close();
});

// ------------------------------------------------------------------ session: tool failure path

test("session: a failed tool is toasted once with the model's failure text and the turn continues", async () => {
  const failureText = "Tool check_resolution_options failed: Simulated failure in check_resolution_options";
  const { factory } = fakeAgentFactory(async (emit, signal, _text, session) => {
    emit(toolStart("c1", "check_resolution_options"));
    await pause(10, signal);
    // An executed-and-failed tool reaches afterToolCall, so the guard's toolLog entry exists.
    session.toolLog.push({ t: Date.now(), tool: "check_resolution_options", args: {}, ok: false, ms: 1 });
    emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "check_resolution_options",
      result: { content: [{ type: "text", text: failureText }], details: {} },
      isError: true,
    } as unknown as AgentEvent);
    emit(delta("Sorry, that did not work. Shall I escalate it? "));
  });
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, { createAgent: factory, log: () => {} });
  assert.deepEqual(ws.ofType("ready")[0].chaos, []);
  ws.clientJson({ type: "text", text: "what can you do about the lamp" });
  await sleep(200);
  const tool = ws.ofType("tool");
  assert.equal(tool.length, 2);
  assert.equal(tool[1].phase, "end");
  assert.equal(tool[1].error, true);
  assert.deepEqual(ws.errors(), [failureText], "one toast, same words the model reads, no doubled prefix");
  assert.equal(ws.ofType("agent_text").map((m) => m.delta).join(""), "Sorry, that did not work. Shall I escalate it? ");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1, "the turn finalized after the failure");
  assert.equal(latency[0].ttsEngine, "none");
  assert.equal(latency[0].cancelled, false);
  vs.close();
});

test("latency: the report carries ttsEngine and ttsEngines, none and empty by default", () => {
  const l = new TurnLatency("t1", "text", Date.now(), 0);
  assert.equal(l.report().ttsEngine, "none");
  assert.deepEqual(l.report().ttsEngines, []);
  l.ttsEngine = "elevenlabs";
  l.ttsEngines = ["elevenlabs", "deepgram"];
  assert.equal(l.report().ttsEngine, "elevenlabs");
  assert.deepEqual(l.report().ttsEngines, ["elevenlabs", "deepgram"]);
});

// ------------------------------------------------------------------ TTS streams that die mid-turn

test("tts: lostChunks re-sends what a dead stream cannot have delivered, biased toward repeating", () => {
  const a = "Alpha one. ";
  const b = "Beta two. ";
  const c = "Gamma three. ";
  // The estimate counts spoken characters (trimmed) at the engine's floor; real audio here runs at 60 ms/char.
  const spoken = (chunks: string[]) => chunks.reduce((n, t) => n + t.trim().length, 0);
  const real = (chunks: string[], extraChars = 0) => (spoken(chunks) + extraChars) * 60 * 32;
  const floor = MS_PER_CHAR_FLOOR.elevenlabs;
  assert.deepEqual(lostChunks([a, b], 2, 0, floor), [a, b], "no audio at all: everything written");
  assert.deepEqual(lostChunks([a, b], 1, real([a]), floor), [b], "audio for a; b was written after the last frame");
  assert.deepEqual(lostChunks([a, b, c], 3, real([a], 1), floor), [b, c], "backlog: a delivered, b barely started, c never started");
  assert.deepEqual(lostChunks([a, b, c], 3, real([a, b, c]), floor), [], "everything delivered");
  assert.deepEqual(lostChunks([a, b, c], 3, spoken([a, b, c]) * 30 * 32, floor), [c], "too little audio for three sentences at the floor: the last one is repeated rather than risked");
  assert.deepEqual(lostChunks([a, b], 0, real([a]), floor), [a, b], "audio that arrived before anything was written covers nothing");
  // Known limit of a floor: a slowly spoken earlier sentence leaves slack that can hide a cut in
  // the next one (a's 600 ms at 60 ms/char is 200 ms more than the floor needs, enough to make
  // b's 360 ms floor budget look met after 160 ms of b). That is the tail-cut case, unrecoverable
  // by re-sending; everything after it is still re-sent.
  assert.deepEqual(lostChunks([a, b, c], 3, real([a], 4), floor), [c], "slack from a hides b's cut; c is still re-sent");
});

test("session: a stream stuck in its close handshake is retired and its sentence re-sent, not dropped", async () => {
  const { factory } = fakeAgentFactory(async (emit, signal) => {
    for (const s of ["Alpha one. ", "Beta two. ", "Gamma three. "]) {
      emit(delta(s));
      if (!(await pause(60, signal))) return;
    }
  });
  const ws = new FakeClientWs();
  const first = el.connections + 1;
  el.closingConnections.add(first);
  const logs: string[] = [];
  // Open TCP handles in this process. The mock's stuck server socket stays open by design (its
  // end is stubbed), so the only way the count can end one above the baseline is if the client
  // terminated its side; a client left in CLOSING would hold a second handle for ws's 30 s timer.
  const tcpHandles = () => process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;
  await sleep(100); // let sockets of earlier tests finish closing
  const handlesBefore = tcpHandles();
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: factory,
    log: (m) => logs.push(m),
  });
  ws.clientJson({ type: "text", text: "say three things" });
  await sleep(700);
  assert.deepEqual(el.receivedBy.get(first), ["Alpha one."], "the first socket got one sentence and then a close frame");
  assert.deepEqual(el.receivedBy.get(first + 1), ["Alpha one.", "Beta two.", "Gamma three."], "the replacement carries the lost sentence too");
  assert.equal(el.connections, first + 1, "one replacement, same engine");
  assert.ok(logs.some((l) => l.startsWith("tts error") && l.includes("failure 1") && l.includes("closing")), `failure counted, got ${JSON.stringify(logs)}`);
  assert.ok(logs.some((l) => l.includes("tts retry") && l.includes("re-sent 1 chunk(s)")), JSON.stringify(logs));
  assert.equal(ws.errors().length, 0, "silent recovery");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1);
  assert.equal(latency[0].ttsEngine, "elevenlabs");
  assert.deepEqual(latency[0].ttsEngines, ["elevenlabs"]);
  assert.equal(ws.audioBytes, mockAudioBytes("Alpha one. ") + mockAudioBytes("Beta two. ") + mockAudioBytes("Gamma three. ") + 320, "all three sentences plus the flush frame");
  const stuck = el.sockets.get(first)!;
  assert.equal(stuck.readyState, WebSocket.CLOSING, "the mock really kept the vendor side of the stuck socket open");
  let handlesAfter = tcpHandles();
  for (let i = 0; i < 50 && handlesAfter > handlesBefore + 1; i++) {
    await sleep(10);
    handlesAfter = tcpHandles();
  }
  assert.equal(handlesAfter, handlesBefore + 1, "only the mock's stuck server socket is left open: the client terminated its side instead of waiting on ws's 30 s close timer");
  vs.close();
});

test("session: a stream that dies after delivering a sentence re-sends only the undelivered one", async () => {
  const { factory } = fakeAgentFactory(async (emit, signal) => {
    emit(delta("Alpha one. "));
    if (!(await pause(60, signal))) return;
    emit(delta("Beta two. "));
  });
  const ws = new FakeClientWs();
  const first = el.connections + 1;
  el.dieOnSecondChunk.add(first);
  const logs: string[] = [];
  const vs = new VoiceSession(ws as unknown as WebSocket, { elevenLabsKey: "el-key", createAgent: factory, log: (m) => logs.push(m) });
  ws.clientJson({ type: "text", text: "say two things" });
  await sleep(600);
  assert.deepEqual(el.receivedBy.get(first), ["Alpha one.", "Beta two."]);
  assert.deepEqual(el.receivedBy.get(first + 1), ["Beta two."], "Alpha's audio had arrived, so only Beta is re-sent");
  assert.ok(logs.some((l) => l.includes("tts retry") && l.includes("re-sent 1 chunk(s)")), JSON.stringify(logs));
  assert.equal(ws.errors().length, 0, "silent recovery");
  assert.equal(ws.audioBytes, mockAudioBytes("Alpha one. ") + mockAudioBytes("Beta two. ") + 320, "each sentence heard exactly once");
  assert.equal(ws.ofType("latency")[0]?.ttsEngine, "elevenlabs");
  vs.close();
});

test("session: after a mid-turn fallback the report names the first-audio engine and lists both", async () => {
  const { factory } = fakeAgentFactory(async (emit, signal) => {
    for (const s of ["Alpha one. ", "Beta two. ", "Gamma three. "]) {
      emit(delta(s));
      if (!(await pause(60, signal))) return;
    }
  });
  const ws = new FakeClientWs();
  const first = el.connections + 1;
  el.dieOnSecondChunk.add(first);
  el.failConnections.add(first + 1);
  const auraBefore = aura.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: factory,
    log: () => {},
  });
  ws.clientJson({ type: "text", text: "say three things" });
  await sleep(700);
  assert.deepEqual(aura.received.slice(auraBefore), ["Beta two.", "Gamma three."], "Aura spoke the tail");
  assert.equal(el.connections, first + 1);
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1);
  assert.ok(latency[0].firstAudioMs !== null);
  assert.equal(latency[0].ttsEngine, "elevenlabs", "firstAudioMs was measured on ElevenLabs, so that is the engine reported");
  assert.deepEqual(latency[0].ttsEngines, ["elevenlabs", "deepgram"]);
  assert.equal(ws.errors().length, 0);
  vs.close();
});

test("session: an engine that failed twice in a turn rests for the cooldown and is probed again after it", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Alpha one. "));
  });
  const ws = new FakeClientWs();
  const firstEl = el.connections + 1;
  el.failConnections.add(firstEl);
  el.failConnections.add(firstEl + 1);
  const auraBefore = aura.received.length;
  const auraConnBefore = aura.connections;
  const logs: string[] = [];
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: factory,
    ttsEngineCooldownMs: 400,
    log: (m) => logs.push(m),
  });
  ws.clientJson({ type: "text", text: "turn one" });
  await sleep(300);
  assert.equal(el.connections, firstEl + 1, "two ElevenLabs streams on the first turn");
  assert.ok(logs.some((l) => l.startsWith("tts engine elevenlabs down for")), JSON.stringify(logs));
  ws.clientJson({ type: "text", text: "turn two" });
  await sleep(300);
  assert.equal(el.connections, firstEl + 1, "no ElevenLabs socket on the second turn");
  assert.equal(aura.connections, auraConnBefore + 2, "Aura was pre-opened directly");
  assert.deepEqual(aura.received.slice(auraBefore), ["Alpha one.", "Alpha one."]);
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 2);
  assert.equal(latency[1].ttsEngine, "deepgram");
  assert.equal(ws.errors().length, 0, "the fallback is silent");
  await sleep(250); // the 400 ms rest started early in turn one, about 850 ms ago now
  ws.clientJson({ type: "text", text: "turn three" });
  await sleep(300);
  assert.ok(logs.some((l) => l === "tts engine elevenlabs back in rotation"), JSON.stringify(logs));
  assert.equal(el.connections, firstEl + 2, "ElevenLabs probed again after the rest");
  assert.equal(ws.ofType("latency")[2]?.ttsEngine, "elevenlabs");
  vs.close();
});

test("session: with every engine resting the turn says so once and stays text only", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Alpha one. Beta two. "));
  });
  const ws = new FakeClientWs();
  const firstEl = el.connections + 1;
  el.failConnections.add(firstEl);
  el.failConnections.add(firstEl + 1);
  const firstAura = aura.connections + 1;
  aura.failConnections.add(firstAura);
  aura.failConnections.add(firstAura + 1);
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: factory,
    log: () => {},
  });
  ws.clientJson({ type: "text", text: "turn one" });
  await sleep(500);
  assert.equal(ws.errors().filter((m) => m.startsWith("Speech synthesis error")).length, 1, JSON.stringify(ws.errors()));
  ws.clientJson({ type: "text", text: "turn two" });
  await sleep(300);
  assert.equal(el.connections, firstEl + 1, "no new ElevenLabs socket");
  assert.equal(aura.connections, firstAura + 1, "no new Aura socket");
  const unavailable = ws.errors().filter((m) => m.startsWith("Speech synthesis unavailable"));
  assert.equal(unavailable.length, 1, JSON.stringify(ws.errors()));
  assert.match(unavailable[0], /elevenlabs resting \d+ s after repeated failures, deepgram resting \d+ s after repeated failures/);
  assert.equal(ws.ofType("agent_text").map((m) => m.delta).join(""), "Alpha one. Beta two. Alpha one. Beta two. ", "text kept flowing on both turns");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 2, "both turns finalized");
  assert.equal(latency[1].ttsEngine, "none");
  vs.close();
});

// ------------------------------------------------------------------ vendor URL hooks

test("vendor url override: loopback is honoured, any other host only with ALLOW_VENDOR_URL_OVERRIDE=1", () => {
  const saved = { url: process.env.DEEPGRAM_SPEAK_WS_URL, allow: process.env.ALLOW_VENDOR_URL_OVERRIDE };
  const warnings: string[] = [];
  const log = (m: string) => warnings.push(m);
  try {
    delete process.env.ALLOW_VENDOR_URL_OVERRIDE;
    process.env.DEEPGRAM_SPEAK_WS_URL = "ws://127.0.0.1:54321";
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), "ws://127.0.0.1:54321");
    process.env.DEEPGRAM_SPEAK_WS_URL = "ws://localhost:54321";
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), "ws://localhost:54321");
    assert.deepEqual(warnings, []);
    process.env.DEEPGRAM_SPEAK_WS_URL = "wss://tts.example.net";
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), undefined, "a stray non-loopback host is ignored");
    assert.equal(
      deepgramSpeakUrl(),
      `wss://api.deepgram.com/v1/speak?model=${DEEPGRAM_TTS_MODEL}&encoding=linear16&sample_rate=16000`,
      "the Aura socket goes to the real host, so the key does too",
    );
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /DEEPGRAM_SPEAK_WS_URL=wss:\/\/tts\.example\.net ignored: not a loopback host and ALLOW_VENDOR_URL_OVERRIDE=1 is not set/);
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), undefined);
    assert.equal(warnings.length, 1, "warned once per value");
    process.env.ALLOW_VENDOR_URL_OVERRIDE = "1";
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), "wss://tts.example.net", "explicitly allowed");
    delete process.env.ALLOW_VENDOR_URL_OVERRIDE;
    process.env.DEEPGRAM_SPEAK_WS_URL = "http://127.0.0.1:1";
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), undefined, "not a websocket URL");
    process.env.DEEPGRAM_SPEAK_WS_URL = "not a url";
    assert.equal(vendorUrlOverride("DEEPGRAM_SPEAK_WS_URL", log), undefined);
    assert.equal(warnings.length, 3);
  } finally {
    if (saved.url === undefined) delete process.env.DEEPGRAM_SPEAK_WS_URL;
    else process.env.DEEPGRAM_SPEAK_WS_URL = saved.url;
    if (saved.allow === undefined) delete process.env.ALLOW_VENDOR_URL_OVERRIDE;
    else process.env.ALLOW_VENDOR_URL_OVERRIDE = saved.allow;
  }
});

// ------------------------------------------------------------------ language: lang query, lang message, Turkish STT / TTS

test("deepgram: the listen URL is nova-3 for en and nova-2 with language=tr for tr, everything else identical", () => {
  const en = new URL(deepgramListenUrl("en"));
  const tr = new URL(deepgramListenUrl("tr"));
  assert.equal(en.searchParams.get("model"), "nova-3");
  assert.equal(en.searchParams.get("language"), null);
  assert.equal(tr.searchParams.get("model"), "nova-2");
  assert.equal(tr.searchParams.get("language"), "tr");
  for (const u of [en, tr]) {
    assert.equal(u.host, "api.deepgram.com");
    assert.equal(u.pathname, "/v1/listen");
    assert.equal(u.searchParams.get("encoding"), "linear16");
    assert.equal(u.searchParams.get("sample_rate"), "16000");
    assert.equal(u.searchParams.get("channels"), "1");
    assert.equal(u.searchParams.get("interim_results"), "true");
    assert.equal(u.searchParams.get("endpointing"), "300");
    assert.equal(u.searchParams.get("utterance_end_ms"), "1000");
    assert.equal(u.searchParams.get("vad_events"), "true");
    assert.equal(u.searchParams.get("smart_format"), "true");
  }
  assert.equal(DEEPGRAM_URL, deepgramListenUrl("en"));
  assert.equal(describeSttModel("en"), "nova-3");
  assert.equal(describeSttModel("tr"), "nova-2 tr");
});

test("elevenlabs: the Turkish stream URL enforces language_code=tr, the English one is unchanged", () => {
  const saved = process.env.ELEVENLABS_WS_URL;
  delete process.env.ELEVENLABS_WS_URL;
  try {
    const en = new URL(elevenLabsUrl("v1"));
    const tr = new URL(elevenLabsUrl("v1", "tr"));
    assert.equal(en.searchParams.get("language_code"), null);
    assert.equal(tr.searchParams.get("language_code"), "tr");
    for (const u of [en, tr]) {
      assert.equal(u.pathname, "/v1/text-to-speech/v1/stream-input");
      assert.equal(u.searchParams.get("model_id"), ELEVENLABS_MODEL_ID);
      assert.equal(u.searchParams.get("output_format"), "pcm_16000");
      assert.equal(u.searchParams.get("inactivity_timeout"), "180");
    }
  } finally {
    if (saved !== undefined) process.env.ELEVENLABS_WS_URL = saved;
  }
});

test("session: ready echoes the language and lists only engines that speak it", () => {
  const { factory } = fakeAgentFactory(async () => {});
  const both = new FakeClientWs();
  const a = new VoiceSession(both as unknown as WebSocket, { deepgramKey: "k", elevenLabsKey: "el", deepgramTtsKey: "dg", createAgent: factory, log: () => {} });
  assert.equal(both.ofType("ready")[0].lang, "en");
  assert.deepEqual(both.ofType("ready")[0].voice, { stt: true, tts: true, ttsEngines: ["elevenlabs", "deepgram"] });
  assert.equal(both.ofType("state")[0].session.lang, "en");
  a.close();

  const tr = new FakeClientWs();
  const b = new VoiceSession(tr as unknown as WebSocket, { lang: "tr", deepgramKey: "k", elevenLabsKey: "el", deepgramTtsKey: "dg", createAgent: factory, log: () => {} });
  assert.equal(tr.ofType("ready")[0].lang, "tr");
  assert.deepEqual(tr.ofType("ready")[0].voice, { stt: true, tts: true, ttsEngines: ["elevenlabs"] }, "Aura is English only");
  assert.equal(tr.ofType("state")[0].session.lang, "tr");
  b.close();

  const auraOnly = new FakeClientWs();
  const c = new VoiceSession(auraOnly as unknown as WebSocket, { lang: "tr", deepgramKey: "k", deepgramTtsKey: "dg", createAgent: factory, log: () => {} });
  assert.deepEqual(auraOnly.ofType("ready")[0].voice, { stt: true, tts: false, ttsEngines: [] }, "text only: no engine speaks Turkish");
  c.close();
});

test("session: a lang message switches the domain session and reopens Deepgram on the Turkish model at the next frame", async () => {
  let domainSession: Session | undefined;
  const { factory, calls } = fakeAgentFactory(async (emit, _signal, _text, session) => {
    domainSession = session;
    emit(delta("ok. "));
  });
  const ws = new FakeClientWs();
  const logs: string[] = [];
  const vs = new VoiceSession(ws as unknown as WebSocket, { deepgramKey: "test-key", createAgent: factory, log: (m) => logs.push(m) });
  const before = dg.sockets.length;
  ws.clientAudio(20);
  const s1 = await dg.waitForSocket(before + 1);
  assert.match(s1.url, /model=nova-3/);
  assert.doesNotMatch(s1.url, /language=/);
  for (let i = 0; i < 100 && s1.ws.readyState !== WebSocket.OPEN; i++) await sleep(5);

  ws.clientJson({ type: "lang", lang: "tr" });
  await sleep(50);
  const states = ws.ofType("state");
  assert.equal(states[states.length - 1].session.lang, "tr", "the state answer echoes the new language");
  for (let i = 0; i < 150 && s1.ws.readyState !== WebSocket.CLOSED; i++) await sleep(10);
  assert.equal(s1.ws.readyState, WebSocket.CLOSED, "the English socket was closed");
  assert.equal(dg.sockets.length, before + 1, "no socket until the next audio frame");
  assert.ok(logs.some((l) => l.includes("lang tr") && l.includes("nova-2 tr")), JSON.stringify(logs));
  assert.deepEqual(ws.errors(), [], "a switch is not a failure: no toast, no backoff");

  ws.clientAudio(20); // reopened at once: the switch did not arm the reconnect backoff
  const s2 = await dg.waitForSocket(before + 2);
  assert.match(s2.url, /model=nova-2&language=tr/);
  await sleep(30);
  dg.final("siparişim nerede", 10);
  await sleep(150);
  assert.deepEqual(calls, ["siparişim nerede"]);
  assert.equal(domainSession?.lang, "tr", "the agent's domain session is Turkish now");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1);
  assert.equal(latency[0].source, "voice");

  ws.clientJson({ type: "lang", lang: "de" });
  await sleep(20);
  assert.ok(ws.errors().some((m) => m.startsWith("Unknown lang: de")), JSON.stringify(ws.errors()));
  assert.equal(domainSession?.lang, "tr", "an unknown lang changes nothing");
  assert.equal(s2.ws.readyState, WebSocket.OPEN, "the Turkish socket stays");
  vs.close();
});

test("session: a Turkish turn is spoken by ElevenLabs and never falls back to Aura", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Merhaba, siparişiniz Salı günü geliyor. "));
  });
  const ws = new FakeClientWs();
  const elBefore = el.received.length;
  const auraConnBefore = aura.connections;
  const vs = new VoiceSession(ws as unknown as WebSocket, { lang: "tr", elevenLabsKey: "el-key", deepgramTtsKey: "dg-key", createAgent: factory, log: () => {} });
  ws.clientJson({ type: "text", text: "siparişim nerede" });
  await sleep(500);
  assert.deepEqual(el.received.slice(elBefore), ["Merhaba, siparişiniz Salı günü geliyor."]);
  assert.equal(aura.connections, auraConnBefore, "no Aura socket for a Turkish turn");
  assert.equal(ws.ofType("latency")[0]?.ttsEngine, "elevenlabs");
  assert.ok(ws.audioBytes > 0);

  // ElevenLabs failing twice: text only, one toast, still no Aura.
  const firstEl = el.connections + 1;
  el.failConnections.add(firstEl);
  el.failConnections.add(firstEl + 1);
  ws.clientJson({ type: "text", text: "tekrar" });
  await sleep(600);
  assert.equal(aura.connections, auraConnBefore, "Aura is not tried even when ElevenLabs is exhausted");
  assert.equal(el.connections, firstEl + 1, "two ElevenLabs streams, then nothing");
  assert.equal(ws.errors().filter((m) => m.startsWith("Speech synthesis error")).length, 1, JSON.stringify(ws.errors()));
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 2);
  assert.equal(latency[1].ttsEngine, "none");
  assert.equal(ws.ofType("agent_text").filter((m) => m.turnId === latency[1].turnId).map((m) => m.delta).join(""), "Merhaba, siparişiniz Salı günü geliyor. ", "text still flows");
  vs.close();
});

test("session: switching to Turkish with only Aura configured says so once and the turn is text only", async () => {
  const { factory } = fakeAgentFactory(async (emit) => {
    emit(delta("Cevap. "));
  });
  const ws = new FakeClientWs();
  const auraConnBefore = aura.connections;
  const vs = new VoiceSession(ws as unknown as WebSocket, { deepgramTtsKey: "dg-key", createAgent: factory, log: () => {} });
  ws.clientJson({ type: "lang", lang: "tr" });
  await sleep(20);
  assert.equal(ws.errors().filter((m) => m.startsWith("No speech engine for tr")).length, 1, JSON.stringify(ws.errors()));
  ws.clientJson({ type: "text", text: "merhaba" });
  await sleep(300);
  assert.equal(aura.connections, auraConnBefore, "no Aura socket");
  assert.equal(ws.errors().length, 1, "no further toast on the turn");
  assert.equal(ws.ofType("latency")[0]?.ttsEngine, "none");
  assert.equal(ws.audioBytes, 0);
  vs.close();
});

test("session: the filler is Turkish on a Turkish voice turn", async () => {
  const { factory } = fakeAgentFactory(slowToolScript);
  const ws = new FakeClientWs();
  const receivedBefore = el.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, { lang: "tr", deepgramKey: "test-key", elevenLabsKey: "el-key", createAgent: factory, log: () => {} });
  const socketsBefore = dg.sockets.length;
  ws.clientAudio(20);
  await dg.waitForSocket(socketsBefore + 1);
  await sleep(30);
  dg.final("HM-1042 teslimatını değiştir", 10);
  await sleep(1300);
  const texts = ws.ofType("agent_text").map((m) => m.delta);
  assert.equal(texts[0], FILLER_TEXTS.tr + " ", JSON.stringify(texts));
  assert.notEqual(FILLER_TEXTS.tr, FILLER_TEXT);
  assert.ok(el.received.slice(receivedBefore).includes(FILLER_TEXTS.tr), "the Turkish filler reached TTS");
  vs.close();
});

// ------------------------------------------------------------------ the assistant speaks first

test("session: greet speaks the fixed greeting as a turn (agent_text, audio, latency source greet) and seeds the history once", async () => {
  const { factory, calls, seeded } = fakeAgentFactory(async (emit) => {
    emit(delta("Merhaba Anna. "));
  });
  const ws = new FakeClientWs();
  const receivedBefore = el.received.length;
  const vs = new VoiceSession(ws as unknown as WebSocket, { lang: "tr", elevenLabsKey: "el-key", createAgent: factory, log: () => {} });
  ws.clientJson({ type: "greet" });
  await sleep(400);
  const texts = ws.ofType("agent_text");
  assert.equal(texts.length, 1, JSON.stringify(texts));
  assert.equal(texts[0].delta, GREETINGS.tr);
  assert.deepEqual(el.received.slice(receivedBefore), ["Merhaba, Hemma destek hattına ulaştınız.", "Mevcut bir siparişinizle ilgili yardımcı olabilirim.", "Kiminle görüşüyorum?"], "spoken sentence by sentence through the normal chunker");
  assert.ok(ws.audioBytes > 0, "audio frames reached the client");
  const latency = ws.ofType("latency");
  assert.equal(latency.length, 1);
  assert.equal(latency[0].source, "greet");
  assert.equal(latency[0].turnId, texts[0].turnId);
  assert.equal(latency[0].sttFinalMs, 0);
  assert.equal(typeof latency[0].firstTokenMs, "number");
  assert.ok(latency[0].firstAudioMs !== null);
  assert.equal(latency[0].ttsEngine, "elevenlabs");
  assert.equal(latency[0].cancelled, false);
  assert.deepEqual(seeded, [GREETINGS.tr], "the greeting went into the agent history as an assistant message");
  assert.deepEqual(calls, [], "no model call for the greeting");
  const statesBefore = ws.ofType("state").length;

  ws.clientJson({ type: "greet" }); // idempotent
  await sleep(200);
  assert.equal(ws.ofType("agent_text").length, 1, "a second greet is ignored");
  assert.equal(ws.ofType("latency").length, 1);
  assert.deepEqual(seeded, [GREETINGS.tr]);
  assert.equal(ws.ofType("state").length, statesBefore);

  ws.clientJson({ type: "text", text: "merhaba, ben Anna" });
  await sleep(300);
  assert.deepEqual(calls, ["merhaba, ben Anna"]);
  assert.equal(ws.ofType("latency").length, 2);
  assert.equal(ws.ofType("latency")[1].source, "text");

  ws.clientJson({ type: "reset" });
  await sleep(100);
  ws.clientJson({ type: "greet" }); // a fresh session may be greeted again
  await sleep(400);
  const afterReset = ws.ofType("latency");
  assert.equal(afterReset.length, 3);
  assert.equal(afterReset[2].source, "greet");
  assert.deepEqual(seeded, [GREETINGS.tr, GREETINGS.tr]);
  vs.close();
});

test("session: greet after the conversation started is ignored; the English greeting is the default; no TTS is fine", async () => {
  const { factory, seeded } = fakeAgentFactory(async (emit) => {
    emit(delta("ok. "));
  });
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, { createAgent: factory, log: () => {} });
  ws.clientJson({ type: "text", text: "hello" });
  await sleep(200);
  ws.clientJson({ type: "greet" });
  await sleep(200);
  assert.deepEqual(seeded, [], "no greeting once the customer has spoken");
  assert.equal(ws.ofType("latency").length, 1);
  vs.close();

  const ws2 = new FakeClientWs();
  const two = fakeAgentFactory(async () => {});
  const vs2 = new VoiceSession(ws2 as unknown as WebSocket, { createAgent: two.factory, log: () => {} });
  ws2.clientJson({ type: "greet" });
  await sleep(100);
  assert.equal(ws2.ofType("agent_text")[0]?.delta, GREETINGS.en);
  const latency = ws2.ofType("latency")[0];
  assert.equal(latency?.source, "greet");
  assert.equal(latency?.ttsEngine, "none", "text only: no engine configured");
  assert.deepEqual(two.seeded, [GREETINGS.en]);
  vs2.close();
});

test("session: the greeting is the first assistant message pi sends to the model on the next turn", async () => {
  const script = scriptedStreamFn([{ text: "Hi Anna, let me look that up." }]);
  const ws = new FakeClientWs();
  let sa: SupportAgent | undefined;
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    log: () => {},
    createAgent: (session, onEvent) => {
      sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent });
      return sa;
    },
  });
  ws.clientJson({ type: "greet" });
  await sleep(100);
  const history = sa!.agent.state.messages;
  assert.equal(history.length, 1);
  assert.equal(history[0].role, "assistant");
  assert.equal(((history[0] as AssistantMessage).content[0] as TextContent).text, GREETINGS.en);
  assert.equal((history[0] as AssistantMessage).stopReason, "stop");
  ws.clientJson({ type: "text", text: "Hi, this is Anna Weber, HM-2201." });
  for (let i = 0; i < 300 && ws.ofType("latency").length < 2; i++) await sleep(10);
  const ctx = script.calls[0];
  assert.ok(ctx, "the model was called for the text turn");
  assert.deepEqual(
    ctx.messages.map((m) => m.role),
    ["assistant", "user"],
    "the greeting precedes the customer's first line in the model's context",
  );
  assert.equal(ws.ofType("agent_text").map((m) => m.delta).join(""), `${GREETINGS.en}Hi Anna, let me look that up.`);
  vs.close();
});

test("session: a barge-in during the greeting cuts the audio and does not re-answer anything", async () => {
  const { factory, calls } = fakeAgentFactory(async () => {});
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    deepgramKey: "test-key",
    elevenLabsKey: "el-key",
    createAgent: factory,
    resumeAfterBargeInMs: 100,
    log: () => {},
  });
  const socketsBefore = dg.sockets.length;
  ws.clientAudio(20);
  await dg.waitForSocket(socketsBefore + 1);
  ws.clientJson({ type: "greet" });
  await sleep(300);
  assert.ok(ws.audioBytes > 0);
  assert.equal(ws.ofType("clear_audio").length, 0);
  dg.speechStarted(); // the customer starts talking over the greeting (6 s of mock audio are still playing)
  await sleep(300);
  assert.equal(ws.ofType("clear_audio").length, 1, "playback cut");
  assert.deepEqual(calls, [], "nothing is re-answered: a greeting has no question to repeat");
  vs.close();
});
