// Chaos smoke for fail=tts: opens /ws?fail=tts, sends one text turn and checks that the turn's
// latency line names ttsEngine "deepgram" (the Aura fallback after the ElevenLabs stand-in
// failed) and that PCM audio bytes actually reached the client. Prints a JSON summary.
// Exit 0 when both hold, 1 otherwise.
//
//   npx tsx scratch/chaos-smoke.ts 3141            (fail=tts, default)
//   npx tsx scratch/chaos-smoke.ts 3141 tts,tool   (any ?fail= value)
import WebSocket from "ws";

const port = Number(process.argv[2] ?? 3141);
const fail = process.argv[3] ?? "tts";
const TURN_TEXT = "Hi, this is Anna Weber, my customer number is HM-2201. What's happening with my most recent order?";
const TIMEOUT_MS = 90_000;

interface Summary {
  fail: string;
  ready?: unknown;
  chaos?: unknown;
  stateOnConnect: boolean;
  tools: string[];
  errors: string[];
  agentTextChars: number;
  agentText: string;
  audioBytes: number;
  audioSeconds: number;
  latency?: Record<string, unknown>;
  ttsEngine?: string;
  ttsEngines?: string[];
  ok: boolean;
  reason?: string;
}

const t0 = Date.now();
const log: string[] = [];
const summary: Summary = {
  fail,
  stateOnConnect: false,
  tools: [],
  errors: [],
  agentTextChars: 0,
  agentText: "",
  audioBytes: 0,
  audioSeconds: 0,
  ok: false,
};

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?fail=${encodeURIComponent(fail)}`);

function finish(reason?: string): void {
  summary.agentTextChars = summary.agentText.length;
  summary.agentText = summary.agentText.slice(0, 300);
  summary.audioSeconds = +(summary.audioBytes / 32000).toFixed(1);
  const engineOk = summary.ttsEngine === "deepgram";
  const audioOk = summary.audioBytes > 0;
  summary.ok = engineOk && audioOk && !reason;
  if (!summary.ok) {
    summary.reason =
      reason ??
      (!engineOk ? `ttsEngine is ${summary.ttsEngine ?? "missing"}, expected deepgram` : `no audio bytes arrived`);
  }
  console.log(log.join("\n"));
  console.log(JSON.stringify(summary, null, 1));
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(summary.ok ? 0 : 1);
}

const timer = setTimeout(() => finish(`no latency event within ${TIMEOUT_MS} ms`), TIMEOUT_MS);

ws.on("message", (d, isBinary) => {
  if (isBinary) {
    if (summary.audioBytes === 0) log.push(`+${Date.now() - t0} first audio frame (${(d as Buffer).length} bytes)`);
    summary.audioBytes += (d as Buffer).length;
    return;
  }
  const m = JSON.parse(d.toString());
  switch (m.type) {
    case "ready":
      summary.ready = m.voice;
      summary.chaos = m.chaos;
      log.push(`+${Date.now() - t0} ready voice=${JSON.stringify(m.voice)} chaos=${JSON.stringify(m.chaos)}`);
      return;
    case "state":
      if (!summary.stateOnConnect) summary.stateOnConnect = true;
      return;
    case "agent_text":
      summary.agentText += m.delta;
      return;
    case "tool":
      summary.tools.push(`${m.name}:${m.phase}`);
      log.push(`+${Date.now() - t0} tool ${m.name} ${m.phase}${m.ms !== undefined ? ` ${m.ms}ms` : ""}`);
      return;
    case "error":
      summary.errors.push(String(m.message));
      log.push(`+${Date.now() - t0} error ${m.message}`);
      return;
    case "latency":
      summary.latency = m;
      summary.ttsEngine = m.ttsEngine;
      summary.ttsEngines = m.ttsEngines;
      log.push(`+${Date.now() - t0} latency ${JSON.stringify(m)}`);
      clearTimeout(timer);
      // Give the trailing audio frames a moment to land, then report.
      setTimeout(() => finish(), 1500);
      return;
    default:
      return;
  }
});

ws.on("open", () => {
  log.push(`+${Date.now() - t0} open, sending text turn`);
  ws.send(JSON.stringify({ type: "text", text: TURN_TEXT }));
});
ws.on("error", (e) => finish(`ws error: ${e.message}`));
ws.on("close", (code) => {
  if (!summary.latency) finish(`socket closed (${code}) before the latency event`);
});
