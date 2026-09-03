// Measures how long an idle Deepgram Aura speak socket (no Speak ever sent) stays open.
import "dotenv/config";
import WebSocket from "ws";
const url = "wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000";
const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
const t0 = Date.now();
ws.on("open", () => console.log(`+${Date.now() - t0}ms open, sending nothing`));
ws.on("message", (d, b) => { if (!b) console.log(`+${Date.now() - t0}ms json ${d.toString()}`); });
ws.on("close", (c, r) => { console.log(`+${Date.now() - t0}ms close ${c} ${r.toString()}`); process.exit(0); });
ws.on("error", (e) => console.log(`+${Date.now() - t0}ms error ${e.message}`));
setTimeout(() => { console.log(`+${Date.now() - t0}ms still open after 150 s; closing`); ws.close(); }, 150000);
