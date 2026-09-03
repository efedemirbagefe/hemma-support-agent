// Verifies the Deepgram Aura streaming TTS WebSocket contract against the live API.
// Logs every JSON message, every binary frame (size, first bytes) and timings.
import "dotenv/config";
import WebSocket from "ws";
const key = process.env.DEEPGRAM_API_KEY!;
const url = "wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000";
const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
const t0 = Date.now();
let bytes = 0, frames = 0, firstAudio = 0, firstSince = "";
let phase = "open";
const stamp = () => `+${Date.now() - t0}ms`;
ws.on("open", () => {
  console.log(stamp(), "open");
  ws.send(JSON.stringify({ type: "Speak", text: "Hello, this is Hemma support. " }));
  console.log(stamp(), "sent Speak #1 (no Flush yet, waiting 2.5 s to see if audio arrives without Flush)");
  phase = "noflush";
  setTimeout(() => {
    console.log(stamp(), `after 2.5 s without Flush: ${frames} frames, ${bytes} bytes`);
    ws.send(JSON.stringify({ type: "Speak", text: "Let me check that order for you. " }));
    ws.send(JSON.stringify({ type: "Flush" }));
    phase = "flush1";
    console.log(stamp(), "sent Speak #2 + Flush");
  }, 2500);
});
ws.on("message", (d, isBinary) => {
  if (isBinary) {
    const b = d as Buffer;
    frames++; bytes += b.length;
    if (!firstAudio) { firstAudio = Date.now() - t0; firstSince = phase; console.log(stamp(), `first binary frame ${b.length} bytes, head ${b.subarray(0, 4).toString("hex")} (${JSON.stringify(b.subarray(0,4).toString("latin1"))}), phase ${phase}`); }
    return;
  }
  const j = JSON.parse(d.toString());
  console.log(stamp(), "json", JSON.stringify(j));
  if (j.type === "Flushed" && phase === "flush1") {
    console.log(stamp(), `Flushed #1: ${frames} frames, ${bytes} bytes = ${(bytes / 32000).toFixed(2)} s`);
    // second utterance on the same socket
    const f = frames, by = bytes;
    ws.send(JSON.stringify({ type: "Speak", text: "Your order will arrive on Tuesday. " }));
    ws.send(JSON.stringify({ type: "Flush" }));
    phase = "flush2";
    console.log(stamp(), "sent Speak #3 + Flush on the same socket");
    setTimeout(() => {}, 0);
    (ws as any)._f1 = [f, by];
  } else if (j.type === "Flushed" && phase === "flush2") {
    const [f, by] = (ws as any)._f1;
    console.log(stamp(), `Flushed #2: +${frames - f} frames, +${bytes - by} bytes`);
    ws.send(JSON.stringify({ type: "Close" }));
    phase = "closing";
    console.log(stamp(), "sent Close");
  }
});
ws.on("close", (c, r) => { console.log(stamp(), `close ${c} ${r.toString()} total ${bytes} bytes ${frames} frames`); process.exit(0); });
ws.on("error", (e) => console.log(stamp(), "ws error", e.message));
setTimeout(() => { console.log(stamp(), "timeout; bytes so far", bytes); process.exit(0); }, 20000);
