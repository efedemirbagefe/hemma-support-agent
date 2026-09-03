import "dotenv/config";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
const key = process.env.DEEPGRAM_API_KEY!;
const wav = readFileSync("scratch/say.wav"); const pcm = wav.subarray(44);
const url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&vad_events=true&smart_format=true";
const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
const t0 = Date.now(); const events: string[] = [];
ws.on("open", () => {
  events.push(`open +${Date.now()-t0}ms`);
  // stream in 20ms chunks (640 bytes) like a mic would
  let i = 0; const step = 640;
  const iv = setInterval(() => { if (i >= pcm.length) { clearInterval(iv); setTimeout(() => ws.send(JSON.stringify({ type: "CloseStream" })), 1500); return; } ws.send(pcm.subarray(i, i + step)); i += step; }, 20);
});
ws.on("message", (d) => { const j = JSON.parse(d.toString()); const t = `+${Date.now()-t0}ms`;
  if (j.type === "SpeechStarted") events.push(`SpeechStarted ${t}`);
  else if (j.type === "UtteranceEnd") events.push(`UtteranceEnd ${t}`);
  else if (j.type === "Results") { const alt = j.channel?.alternatives?.[0]; if (alt?.transcript) events.push(`Results final=${j.is_final} speech_final=${j.speech_final} ${t}: "${alt.transcript}"`); }
  else events.push(`${j.type} ${t}`); });
ws.on("close", () => { console.log(events.join("\n")); });
ws.on("error", (e) => { console.log("error", e.message); });
