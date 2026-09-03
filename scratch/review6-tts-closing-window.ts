/**
 * Review probe (voice TTS fallback). Three experiments against mocks, no vendor keys:
 *  1. ElevenLabs sends a close frame (no error JSON) right after the first sentence and the
 *     TCP FIN is delayed: while the socket sits in CLOSING, does the next sentence open a
 *     replacement and silently drop the first sentence (lostText never consulted)?
 *  2. ElevenLabs delivers audio for sentence 1 then dies; Aura speaks sentence 2: what does
 *     the latency report call the engine?
 *  3. ElevenLabs rejects every stream (dead key): how many ElevenLabs sockets per turn over
 *     two turns (is there any cross-turn memory)?
 * Run: npx tsx scratch/review6-tts-closing-window.ts
 */
import { EventEmitter, once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SupportAgent } from "../src/agent/createAgent";
import type { Session } from "../src/domain/session";
import { VoiceSession, type ServerMessage } from "../src/voice/session-voice";

type Mode = "closing-window" | "audio-then-die" | "always-reject" | "mixed";

class MockEl {
  readonly wss = new WebSocketServer({ port: 0 });
  connections = 0;
  readonly received = new Map<number, string[]>();
  mode: Mode = "closing-window";
  base = 0;
  constructor() {
    this.wss.on("connection", (ws) => {
      const n = ++this.connections;
      const local = n - this.base;
      this.received.set(n, []);
      let chunks = 0;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (typeof msg.text !== "string") return;
        if (msg.voice_settings) {
          if (this.mode === "always-reject" || (this.mode === "mixed" && local === 2)) {
            ws.send(JSON.stringify({ error: "invalid_api_key", message: "invalid api key", code: 1008 }));
            ws.close(1008, "invalid api key");
          }
          return;
        }
        if (msg.text === "") {
          ws.send(JSON.stringify({ isFinal: true }));
          ws.close(1000);
          return;
        }
        chunks++;
        this.received.get(n)!.push(msg.text.trim());
        if (this.mode === "closing-window" && local === 1) {
          // Close frame without an error message, and never send the FIN: the client stays in
          // CLOSING until its own 30 s close timer. Mirrors a vendor whose TCP teardown lags.
          (ws as any)._socket.end = () => {};
          ws.close(1011, "server going away");
          return;
        }
        if ((this.mode === "audio-then-die" || this.mode === "mixed") && local === 1) {
          if (chunks === 1) {
            ws.send(JSON.stringify({ audio: Buffer.alloc(640).toString("base64"), isFinal: false }));
          } else {
            ws.send(JSON.stringify({ error: "system_busy", message: "system busy", code: 1011 }));
            ws.close(1011, "busy");
          }
          return;
        }
        ws.send(JSON.stringify({ audio: Buffer.alloc(640).toString("base64"), isFinal: false }));
      });
    });
  }
  async start(): Promise<string> {
    if (!this.wss.address()) await once(this.wss, "listening");
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
}

class MockAura {
  readonly wss = new WebSocketServer({ port: 0 });
  connections = 0;
  readonly received: string[] = [];
  constructor() {
    this.wss.on("connection", (ws) => {
      this.connections++;
      ws.send(JSON.stringify({ type: "Metadata", request_id: "r", model_name: "aura-2-thalia-en" }));
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === "Speak") {
          this.received.push(msg.text.trim());
          ws.send(Buffer.alloc(640), { binary: true });
        } else if (msg.type === "Flush") {
          ws.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
        } else if (msg.type === "Close") ws.close(1000);
      });
    });
  }
  async start(): Promise<string> {
    if (!this.wss.address()) await once(this.wss, "listening");
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
}

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
  ofType<T extends ServerMessage["type"]>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter((m) => m.type === type) as Array<Extract<ServerMessage, { type: T }>>;
  }
}

type Emit = (e: AgentEvent) => void;
const delta = (text: string): AgentEvent =>
  ({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: {} } }) as unknown as AgentEvent;

function fakeAgent(script: (emit: Emit) => Promise<void>) {
  return (_session: Session, onEvent: Emit): SupportAgent => {
    let streaming = false;
    let idle: Promise<void> = Promise.resolve();
    const agent = { state: { isStreaming: false, errorMessage: undefined }, waitForIdle: () => idle };
    return {
      agent: agent as unknown as SupportAgent["agent"],
      async sendUserText() {
        streaming = true;
        idle = (async () => {
          try {
            await script(onEvent);
          } finally {
            streaming = false;
            onEvent({ type: "agent_end", messages: [] } as unknown as AgentEvent);
          }
        })();
        await idle;
      },
      abort() {},
      isBusy: () => streaming,
    };
  };
}

const el = new MockEl();
const aura = new MockAura();
process.env.ELEVENLABS_WS_URL = await el.start();
process.env.DEEPGRAM_SPEAK_WS_URL = await aura.start();

async function run(mode: Mode, turns: number, sentences: string[]): Promise<void> {
  el.mode = mode;
  el.base = el.connections;
  const elConnBefore = el.connections;
  const auraBefore = aura.received.length;
  const logs: string[] = [];
  const ws = new FakeClientWs();
  const vs = new VoiceSession(ws as unknown as WebSocket, {
    elevenLabsKey: "el-key",
    deepgramTtsKey: "dg-key",
    createAgent: fakeAgent(async (emit) => {
      for (const s of sentences) {
        emit(delta(s + " "));
        await sleep(60);
      }
    }),
    log: (m) => logs.push(m),
  });
  for (let i = 0; i < turns; i++) {
    ws.clientJson({ type: "text", text: `turn ${i + 1}` });
    await sleep(900);
  }
  console.log(`\n== ${mode} ==`);
  console.log("elevenlabs sockets opened:", el.connections - elConnBefore);
  for (let n = elConnBefore + 1; n <= el.connections; n++) console.log(`  el conn ${n} received:`, el.received.get(n));
  console.log("aura received:", aura.received.slice(auraBefore));
  console.log("client audio bytes:", ws.audioBytes);
  console.log("errors:", ws.ofType("error").map((e) => e.message));
  console.log("latency:", ws.ofType("latency").map((l) => ({ ttsEngine: l.ttsEngine, firstAudioMs: l.firstAudioMs, totalMs: l.totalMs })));
  console.log("logs:", logs.filter((l) => l.startsWith("tts")));
  vs.close();
}

await run("closing-window", 1, ["Alpha one.", "Beta two.", "Gamma three."]);
await run("audio-then-die", 1, ["Alpha one.", "Beta two."]);
await run("always-reject", 2, ["Alpha one.", "Beta two."]);
await run("mixed", 1, ["Alpha one.", "Beta two.", "Gamma three."]);
process.exit(0);
