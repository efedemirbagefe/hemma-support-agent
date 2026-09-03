/**
 * Replays the 8-step demo over /ws in text mode against a running server and checks the
 * tool stream and the final state, step by step. Exit 1 on any failed assertion.
 *
 *   npm run demo:check                       (ws://127.0.0.1:3000/ws)
 *   npm run demo:check -- --port 3131
 *   npm run demo:check -- --url https://hemma.example.com   (wss://hemma.example.com/ws)
 *   npm run demo:check -- --url wss://host/ws --timeout 120000 --json
 *
 * Step 2 (barge-in) is voice only and reported as SKIP. One extra clarifying turn per step is
 * tolerated where the brief allows it and reported as WARN, never as PASS.
 */
import WebSocket from "ws";
import { formatReport, mergeToolEvent, runDemo, type ToolPhase, type TurnRecord } from "../src/agent/demo-script";
import type { SessionSnapshot } from "../src/domain/session";

interface Args {
  port: number;
  url?: string;
  timeoutMs: number;
  json: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 3000, timeoutMs: 90_000, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--port") args.port = Number(next());
    else if (a.startsWith("--port=")) args.port = Number(a.slice(7));
    else if (a === "--url") args.url = next();
    else if (a.startsWith("--url=")) args.url = a.slice(6);
    else if (a === "--timeout") args.timeoutMs = Number(next());
    else if (a.startsWith("--timeout=")) args.timeoutMs = Number(a.slice(10));
    else if (a === "--json") args.json = true;
    else if (a === "--quiet") args.quiet = true;
    else if (/^\d+$/.test(a)) args.port = Number(a); // scratch/demo-replay.ts compatibility: bare port
    else if (a === "--help" || a === "-h") {
      console.log("usage: demo-check [--port N] [--url ws(s)://host/ws | http(s)://host] [--timeout ms] [--json] [--quiet]");
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}`);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) throw new Error("--port must be a positive number");
  return args;
}

/** ws URL of the server: --url wins (http(s) is turned into ws(s) + /ws), else localhost with --port. */
export function resolveWsUrl(args: Pick<Args, "port" | "url">): string {
  if (!args.url) return `ws://127.0.0.1:${args.port}/ws`;
  const u = new URL(args.url);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`Unsupported URL scheme ${u.protocol}`);
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/ws";
  return u.toString();
}

function healthUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/healthz";
  return u.toString();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wsUrl = resolveWsUrl(args);
  const log = args.quiet ? () => undefined : (line: string) => console.log(line);

  let modelId = "unknown";
  try {
    const res = await fetch(healthUrl(wsUrl), { signal: AbortSignal.timeout(5000) });
    const health = (await res.json()) as { features?: { model?: boolean; modelId?: string; stt?: boolean; tts?: boolean } };
    // features.model is the boolean "has ANTHROPIC_API_KEY"; features.modelId is the requested model id.
    modelId = health.features?.modelId ?? (health.features?.model === false ? "none (no ANTHROPIC_API_KEY)" : "unknown");
  } catch {
    /* healthz is best effort */
  }

  const ws = new WebSocket(wsUrl);
  let current: TurnRecord | undefined;
  let finish: (() => void) | undefined;
  let voice: { stt: boolean; tts: boolean } = { stt: false, tts: false };
  let ready = false;
  const readyWaiters: Array<() => void> = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // TTS audio for a text turn; not measured here
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === "ready") {
      ready = true;
      voice = (m.voice as typeof voice) ?? voice;
      for (const w of readyWaiters.splice(0)) w();
      return;
    }
    if (!current) return;
    switch (m.type) {
      case "agent_text":
        current.text += String(m.delta ?? "");
        return;
      case "tool":
        mergeToolEvent(current.tools, {
          name: String(m.name),
          phase: m.phase as ToolPhase,
          args: m.args,
          detail: typeof m.detail === "string" ? m.detail : undefined,
          error: m.error === true,
          ms: typeof m.ms === "number" ? m.ms : undefined,
        });
        return;
      case "state":
        current.state = m.session as SessionSnapshot;
        return;
      case "error":
        current.errors.push(String(m.message));
        return;
      case "latency":
        current.firstTokenMs = typeof m.firstTokenMs === "number" ? m.firstTokenMs : null;
        current.totalMs = typeof m.totalMs === "number" ? m.totalMs : null;
        finish?.();
        return;
      default:
        return;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(new Error(`cannot connect to ${wsUrl}: ${err.message}`)));
  });
  await new Promise<void>((resolve, reject) => {
    if (ready) return resolve();
    const t = setTimeout(() => reject(new Error("no ready message from the server")), 10_000);
    readyWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
  ws.on("error", (err) => console.error(`ws error: ${err.message}`));
  ws.on("close", (code) => {
    if (current) current.errors.push(`socket closed (${code}) during a turn`);
    finish?.();
  });

  console.log(`demo-check: ${wsUrl} model ${modelId} stt ${voice.stt} tts ${voice.tts}${voice.tts ? " (totals include synthesis of the text turn)" : ""}`);

  const sendTurn = (text: string, step: number, extra: boolean): Promise<TurnRecord> => {
    const rec: TurnRecord = { step, user: text, extra, text: "", tools: [], firstTokenMs: null, totalMs: null, errors: [] };
    current = rec;
    return new Promise<TurnRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        current = undefined;
        finish = undefined;
        reject(new Error(`turn timed out after ${args.timeoutMs} ms: "${text}"`));
      }, args.timeoutMs);
      finish = () => {
        clearTimeout(timer);
        current = undefined;
        finish = undefined;
        resolve(rec);
      };
      ws.send(JSON.stringify({ type: "text", text }));
    });
  };

  let exitCode = 1;
  try {
    const report = await runDemo({ sendTurn, textMode: true, log });
    console.log("");
    console.log(formatReport(report));
    if (args.json) console.log(JSON.stringify({ wsUrl, modelId, voice, ...report }, null, 1));
    exitCode = report.ok ? 0 : 1;
  } catch (err) {
    console.error(`demo-check aborted: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
