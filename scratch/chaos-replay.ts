// Text-mode replay through /ws with chaos toggles: node scratch/chaos-replay.ts <port> <fail list>
// Prints per turn: tools (with phase), agent text, latency incl. ttsEngine, audio bytes.
import WebSocket from "ws";
const port = Number(process.argv[2] ?? 3131);
const fail = process.argv[3] ?? "";
const stepsAll = [
  "Hi, this is Anna Weber, my phone number is +49 30 1234567. Can you tell me about my most recent order?",
  "A lamp from an earlier order arrived damaged. What can you do?",
  "Please try again.",
];
const steps = stepsAll.slice(0, Number(process.env.STEPS ?? stepsAll.length));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${fail ? `?fail=${fail}` : ""}`);
let cur: any = null; let ready: any = null; const turns: any[] = [];
const send = (text: string) => new Promise<void>((res) => { cur = { text, agent: "", tools: [] as any[], errors: [] as string[], latency: null as any, audio: 0 }; ws.send(JSON.stringify({ type: "text", text })); const iv = setInterval(() => { if (cur.latency) { clearInterval(iv); turns.push(cur); res(); } }, 100); });
ws.on("message", (d, isBinary) => { if (isBinary) { if (cur) cur.audio += (d as Buffer).length; return; } const m = JSON.parse(d.toString());
  if (m.type === "ready") ready = m;
  else if (m.type === "agent_text") cur.agent += m.delta;
  else if (m.type === "tool") cur.tools.push(`${m.name}:${m.phase}${m.error ? "(error)" : ""}${m.phase !== "start" && m.detail ? " " + String(m.detail).slice(0, 70) : ""}`);
  else if (m.type === "latency") cur.latency = m;
  else if (m.type === "error") (cur ?? { errors: [] }).errors.push(m.message); });
ws.on("open", async () => {
  await new Promise(r => setTimeout(r, 300));
  console.log("READY", JSON.stringify({ voice: ready?.voice, chaos: ready?.chaos }));
  for (const s of steps) { await send(s); const t = turns[turns.length - 1]; await new Promise(r => setTimeout(r, 300)); console.log(`\nUSER: ${s}\nTOOLS: ${t.tools.join(" | ")}\nERRORS: ${JSON.stringify(t.errors)}\nAGENT: ${t.agent.trim().slice(0, 300)}\nLATENCY: ${JSON.stringify({ tok: t.latency.firstTokenMs, aud: t.latency.firstAudioMs, tool: t.latency.toolMs, total: t.latency.totalMs, tts: t.latency.ttsEngine })} audioBytes=${t.audio} (${(t.audio/32000).toFixed(1)} s)`); }
  ws.close(); process.exit(0);
});
ws.on("error", (e) => { console.log("ws error", e.message); process.exit(1); });
