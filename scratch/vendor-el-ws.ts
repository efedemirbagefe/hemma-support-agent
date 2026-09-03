import "dotenv/config";
import WebSocket from "ws";
const key = process.env.ELEVENLABS_API_KEY!; const voice = process.env.ELEVENLABS_VOICE_ID!;
const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;
const ws = new WebSocket(url, { headers: { "xi-api-key": key } });
const t0 = Date.now(); let bytes = 0; let first = 0; let msgs = 0;
ws.on("open", () => {
  ws.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 }, xi_api_key: key }));
  ws.send(JSON.stringify({ text: "Hello, this is Nordvik Home support. " }));
  ws.send(JSON.stringify({ text: "Let me check that order for you. " }));
  ws.send(JSON.stringify({ text: "" }));
});
ws.on("message", (d) => { msgs++; const j = JSON.parse(d.toString()); if (j.audio) { const n = Buffer.from(j.audio, "base64").length; if (!first) first = Date.now() - t0; bytes += n; } if (j.error) console.log("error msg:", JSON.stringify(j)); if (j.isFinal) { console.log(`first audio +${first}ms, total ${bytes} bytes (${(bytes/32000).toFixed(2)}s), ${msgs} msgs, done +${Date.now()-t0}ms`); ws.close(); } });
ws.on("close", (c, r) => { if (!bytes) console.log("closed without audio", c, r.toString()); });
ws.on("error", (e) => console.log("ws error", e.message));
setTimeout(() => { console.log("timeout; bytes so far", bytes); process.exit(0); }, 15000);
