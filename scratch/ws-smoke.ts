/**
 * Integration smoke for the WS server in text-only mode (no vendor keys).
 *   PORT=3123 ANTHROPIC_API_KEY= DEEPGRAM_API_KEY= ELEVENLABS_API_KEY= npx tsx src/server.ts &
 *   npx tsx scratch/ws-smoke.ts 3123
 * Connects to /ws, sends {type:"text", text:"hi"}, waits for a `state` event that arrives after
 * the send, and prints one JSON summary. Exit 0 = the server answered and is still up.
 */
import WebSocket from "ws";

const port = Number(process.argv[2] ?? process.env.PORT ?? 3123);
const base = `http://127.0.0.1:${port}`;
const TIMEOUT_MS = 30_000;

interface Summary {
  healthBefore: unknown;
  healthAfter: unknown;
  received: Array<{ type: string; summary: string }>;
  stateAfterText: boolean;
  errorAfterText?: string;
  agentTextChars: number;
  serverAlive: boolean;
  ok: boolean;
  failure?: string;
}

async function health(): Promise<unknown> {
  const res = await fetch(`${base}/healthz`);
  return { status: res.status, body: await res.json() };
}

function describe(msg: Record<string, unknown>): string {
  switch (msg.type) {
    case "state": {
      const s = msg.session as Record<string, unknown> | undefined;
      return `session id=${String(s?.id ?? "?").slice(0, 8)} customer=${s?.customer ? "yes" : "none"} applied=${Array.isArray(s?.applied) ? s.applied.length : "?"}`;
    }
    case "error":
      return String(msg.message);
    case "agent_text":
      return JSON.stringify(msg.delta);
    case "tool":
      return `${String(msg.name)} ${String(msg.phase)}`;
    case "latency":
      return `firstToken=${String(msg.firstTokenMs)} total=${String(msg.totalMs)} cancelled=${String(msg.cancelled)}`;
    case "ready":
      return `voice=${JSON.stringify(msg.voice)}`;
    default:
      return JSON.stringify(msg).slice(0, 120);
  }
}

async function main(): Promise<void> {
  const summary: Summary = {
    healthBefore: undefined,
    healthAfter: undefined,
    received: [],
    stateAfterText: false,
    agentTextChars: 0,
    serverAlive: false,
    ok: false,
  };
  summary.healthBefore = await health();

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let sent = false;
    let done = false;
    const finish = (failure?: string): void => {
      if (done) return;
      done = true;
      if (failure) summary.failure = failure;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(() => finish(`timeout after ${TIMEOUT_MS} ms without a state event after the text`), TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "text", text: "hi" }));
      sent = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        summary.received.push({ type: "binary", summary: `${(data as Buffer).length} bytes` });
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        summary.received.push({ type: "unparseable", summary: data.toString("utf8").slice(0, 80) });
        return;
      }
      summary.received.push({ type: String(msg.type), summary: describe(msg) });
      if (msg.type === "agent_text" && typeof msg.delta === "string") summary.agentTextChars += msg.delta.length;
      if (!sent) return;
      if (msg.type === "error") summary.errorAfterText = String(msg.message);
      if (msg.type === "state") summary.stateAfterText = true;
      // A latency event is the last thing the server sends for a turn: the turn is over.
      if (msg.type === "latency") setTimeout(() => finish(), 200);
    });
    ws.on("error", (err) => finish(`ws error: ${err.message}`));
    ws.on("close", (code) => {
      if (!done) finish(`ws closed early (${code})`);
    });
  });

  try {
    summary.healthAfter = await health();
    summary.serverAlive = (summary.healthAfter as { status: number }).status === 200;
  } catch (err) {
    summary.serverAlive = false;
    summary.failure = summary.failure ?? `healthz after turn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  summary.ok = summary.serverAlive && summary.stateAfterText;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
