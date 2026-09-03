// End-to-end voice smoke: streams a spoken utterance (say.wav) into /ws like a mic, expects
// stt final -> agent text -> binary audio -> latency. Then barge-in: streams a second utterance
// while audio is flowing and expects clear_audio. Prints a JSON summary.
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const port = Number(process.argv[2] ?? 3131);
function wavPcm(text: string, name: string): Buffer {
  execSync(`say -v Samantha -o scratch/${name}.aiff "${text}" && afconvert -f WAVE -d LEI16@16000 -c 1 scratch/${name}.aiff scratch/${name}.wav`);
  return readFileSync(`scratch/${name}.wav`).subarray(44);
}
const u1 = wavPcm("Hi, this is Anna Weber, my phone number is plus four nine, three zero, one two three four five six seven. Can you tell me about my most recent order?", "u1");
const u2 = wavPcm("Sorry to interrupt, actually I have a question about a damaged lamp from an earlier order.", "u2");
const ws = new WebSocket((process.env.WS_URL || `ws://127.0.0.1:${port}/ws`));
const t0 = Date.now(); const log: string[] = []; let audioBytes = 0; let audioTurns = new Set<string>(); let latencies: any[] = []; let clearAudio = 0; let stt: string[] = []; let agentText = ""; let tools: string[] = []; let phase = 0;
const stream = (pcm: Buffer) => new Promise<void>((res) => { let i = 0; const iv = setInterval(() => { if (i >= pcm.length) { clearInterval(iv); res(); return; } ws.send(pcm.subarray(i, i + 640)); i += 640; }, 20); });
const silence = (ms: number) => new Promise<void>((res) => { let n = 0; const iv = setInterval(() => { ws.send(Buffer.alloc(640)); if ((n += 20) >= ms) { clearInterval(iv); res(); } }, 20); });
ws.on("message", (d, isBinary) => {
  if (isBinary) { audioBytes += (d as Buffer).length; return; }
  const m = JSON.parse(d.toString());
  if (m.type === "stt" && m.final) { stt.push(m.text); log.push(`+${Date.now()-t0} stt final: ${m.text}`); }
  else if (m.type === "agent_text") agentText += m.delta;
  else if (m.type === "tool") { tools.push(`${m.name}:${m.phase}`); log.push(`+${Date.now()-t0} tool ${m.name} ${m.phase}${m.detail ? " " + String(m.detail).slice(0,60) : ""}`); }
  else if (m.type === "clear_audio") { clearAudio++; log.push(`+${Date.now()-t0} clear_audio`); }
  else if (m.type === "latency") { latencies.push(m); log.push(`+${Date.now()-t0} latency ${JSON.stringify({stt:m.sttFinalMs, tok:m.firstTokenMs, aud:m.firstAudioMs, tool:m.toolMs, total:m.totalMs, cancelled:m.cancelled})}`); }
  else if (m.type === "error") log.push(`+${Date.now()-t0} error ${m.message}`);
  else if (m.type === "ready") log.push(`+${Date.now()-t0} ready ${JSON.stringify(m.voice)}`);
});
ws.on("open", async () => {
  await stream(u1); await silence(1500);
  // wait until agent audio is flowing, then barge in
  const t1 = Date.now(); while (audioBytes < 32000 && Date.now() - t1 < 25000) await new Promise(r => setTimeout(r, 100));
  log.push(`+${Date.now()-t0} barge-in starts (audio so far ${audioBytes} bytes)`);
  const before = audioBytes;
  await stream(u2); await silence(1500);
  const t2 = Date.now(); while (latencies.length < 2 && Date.now() - t2 < 30000) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 1500));
  console.log(log.join("\n"));
  console.log(JSON.stringify({ sttFinals: stt.length, tools, audioBytes, audioSeconds: +(audioBytes/32000).toFixed(1), clearAudio, latencies: latencies.length, agentTextChars: agentText.length, agentText: agentText.slice(0, 400) }, null, 1));
  ws.close(); process.exit(0);
});
ws.on("error", (e) => { console.log("ws error", e.message); process.exit(1); });
