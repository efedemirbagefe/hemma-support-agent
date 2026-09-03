// Replays the 8-step demo through /ws in text mode against the real model and checks the guards.
import WebSocket from "ws";
const port = Number(process.argv[2] ?? 3131);
const steps = [
  "Hi, this is Anna Weber, my phone number is +49 30 1234567. Can you tell me about my most recent order?",
  "Actually, wait. I have a problem with a lamp from an earlier order, it arrived damaged.",
  "Yes please, go ahead with that.",
  "Ok. Back to the sofa cover order. Can you move the delivery to Friday?",
  "The morning slot on Friday please.",
  "Yes, confirm.",
  "Yes, confirm.",
  "Great, thanks. That's all.",
];
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let turnLog: any[] = []; let cur: any = null; let state: any = null;
const send = (text: string) => new Promise<void>((res) => { cur = { text, agent: "", tools: [] as any[], latency: null as any }; ws.send(JSON.stringify({ type: "text", text })); const iv = setInterval(() => { if (cur.latency) { clearInterval(iv); turnLog.push(cur); res(); } }, 100); });
ws.on("message", (d, isBinary) => { if (isBinary) return; const m = JSON.parse(d.toString());
  if (m.type === "agent_text") cur.agent += m.delta;
  else if (m.type === "tool") cur.tools.push({ name: m.name, phase: m.phase, detail: m.detail ? String(m.detail).slice(0, 80) : undefined, args: m.phase === "start" ? m.args : undefined });
  else if (m.type === "latency") cur.latency = { tok: m.firstTokenMs, tool: m.toolMs, total: m.totalMs };
  else if (m.type === "state") state = m.session;
  else if (m.type === "error") cur.tools.push({ error: m.message }); });
ws.on("open", async () => {
  for (const s of steps) { await send(s); const t = turnLog[turnLog.length - 1]; console.log(`\nUSER: ${s}\nTOOLS: ${t.tools.filter((x: any) => x.phase !== "end").map((x: any) => x.name ? `${x.name}${x.phase === "blocked" ? "[BLOCKED " + x.detail + "]" : ""}` : "ERR:" + x.error).join(" -> ")}\nAGENT: ${t.agent.trim().slice(0, 300)}\nLATENCY: ${JSON.stringify(t.latency)}`); }
  await new Promise(r => setTimeout(r, 500));
  console.log("\nFINAL STATE:", JSON.stringify({ applied: state?.applied, cases: state?.cases, proposals: state?.proposals, pending: state?.pending }, null, 1));
  ws.close(); process.exit(0);
});
