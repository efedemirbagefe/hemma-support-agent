import "dotenv/config";
import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { DEFAULT_MODEL_ID } from "./agent/createAgent";
import { DEFAULT_LANG, parseLang } from "./domain/lang";
import { parseChaos } from "./voice/chaos";
import { describeSttModel } from "./voice/deepgram";
import { DEEPGRAM_TTS_MODEL } from "./voice/deepgram-tts";
import { DEFAULT_VOICE_ID } from "./voice/elevenlabs";
import type { TtsVendor } from "./voice/tts";
import { VoiceSession } from "./voice/session-voice";
import { VENDOR_URL_ENV, vendorUrlOverride } from "./voice/vendor-url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const STARTED_AT = Date.now();
/** Largest client WS message we accept. Mic frames are a few KB; text is capped far below this. */
const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** First non-empty value among the given env vars, trimmed. */
function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const v = (process.env[name] ?? "").trim();
    if (v) return v;
  }
  return undefined;
}

const voice = {
  deepgramKey: envFirst("DEEPGRAM_API_KEY"),
  elevenLabsKey: envFirst("ELEVENLABS_API_KEY"),
  // VOICE_ID is the contract name; .env.example ships ELEVENLABS_VOICE_ID. Both work.
  voiceId: envFirst("VOICE_ID", "ELEVENLABS_VOICE_ID"),
  // Aura voice id (an aura-2-*-en model); defaults to DEEPGRAM_TTS_MODEL (deepgram-tts.ts).
  deepgramTtsModel: envFirst("DEEPGRAM_TTS_MODEL"),
  modelId: envFirst("MODEL_ID"),
};
const hasAnthropic = !!envFirst("ANTHROPIC_API_KEY");
/** Vendor TTS engines in preference order: ElevenLabs, then Deepgram Aura (same key as STT). */
const ttsEngines: TtsVendor[] = [...(voice.elevenLabsKey ? (["elevenlabs"] as const) : []), ...(voice.deepgramKey ? (["deepgram"] as const) : [])];
/**
 * What a client is offered, browser tts tier included: the server always structurally offers
 * it (a connecting browser reports the truth in its own "caps" message, see CONTRACTS.md), so
 * even a deployment with zero vendor keys shows tts as available here.
 */
const exposedTtsEngines: (TtsVendor | "browser")[] = [...ttsEngines, "browser"];
/** Extra browser origins allowed on /ws (comma separated), for a UI served from another host. */
const extraOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const log = (msg: string): void => console.error(`${new Date().toISOString()} [server] ${msg}`);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    sendJson(res, 400, { error: "bad request", path: urlPath });
    return;
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel === "/brief") rel = "/brief.html";
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    sendJson(res, 404, { error: "not found", path: rel });
    return;
  }
  if (stat.isDirectory()) {
    const index = path.join(abs, "index.html");
    try {
      stat = await fs.stat(index);
      return serveFile(req, res, index, stat.size);
    } catch {
      sendJson(res, 404, { error: "not found", path: rel });
      return;
    }
  }
  return serveFile(req, res, abs, stat.size);
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, abs: string, size: number): void {
  const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": "no-cache" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(abs);
  stream.on("error", (err) => {
    log(`static read error ${abs}: ${err.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      sessions: sessions.size,
      features: {
        model: hasAnthropic,
        // Requested id (MODEL_ID or the code default); createSupportAgent falls back to its
        // registry fallback when pi-ai does not know this id.
        modelId: voice.modelId ?? DEFAULT_MODEL_ID,
        stt: !!voice.deepgramKey,
        // The browser tts tier is always structurally offered (a connecting client reports its
        // own truth via "caps"), so this is true even with zero vendor keys configured.
        tts: true,
        ttsEngines: exposedTtsEngines,
      },
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  serveStatic(req, res, url.pathname).catch((err) => {
    log(`static error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    else res.end();
  });
});

/**
 * Browsers always send Origin on a WebSocket handshake; it must be the page we served (same
 * host as the request) or an explicitly allowed one. Requests without Origin come from
 * non-browser clients (tests, curl) and are accepted. This stops any other page open in the
 * same browser from driving the agent through localhost.
 */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (extraOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost.length > 0 && originHost === (req.headers.host ?? "");
}

const sessions = new Set<VoiceSession>();
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!originAllowed(req)) {
    log(`ws upgrade refused: origin ${String(req.headers.origin)} does not match host ${String(req.headers.host)}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  // Demo chaos toggles live only in the upgrade URL (?fail=tool,tts,stt), never in env.
  const chaos = parseChaos(url.searchParams.getAll("fail").join(","));
  // Session language (?lang=en|tr, default en); a {type:"lang"} message can switch it later.
  const lang = parseLang(url.searchParams.get("lang")) ?? DEFAULT_LANG;
  wss.handleUpgrade(req, socket, head, (ws) => {
    const vs = new VoiceSession(ws, {
      deepgramKey: voice.deepgramKey,
      elevenLabsKey: voice.elevenLabsKey,
      deepgramTtsKey: voice.deepgramKey,
      deepgramTtsModel: voice.deepgramTtsModel,
      voiceId: voice.voiceId,
      modelId: voice.modelId,
      chaos,
      lang,
    });
    sessions.add(vs);
    log(`client connected (${vs.id}) lang=${lang}${chaos.length > 0 ? ` chaos=${chaos.join(",")}` : ""}, ${sessions.size} open`);
    ws.on("close", () => {
      sessions.delete(vs);
      log(`client disconnected (${vs.id}), ${sessions.size} open`);
    });
  });
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}  (public: ${PUBLIC_DIR}, ws: /ws, health: /healthz)`);
  if (!hasAnthropic) log("ANTHROPIC_API_KEY missing: the agent cannot answer; only STT transcripts and errors will flow");
  if (!voice.deepgramKey) log("DEEPGRAM_API_KEY missing: voice input OFF (text input still works)");
  const resolvedAuraModel = voice.deepgramTtsModel ?? DEEPGRAM_TTS_MODEL;
  if (ttsEngines.length === 0) {
    log("ELEVENLABS_API_KEY and DEEPGRAM_API_KEY missing: no vendor voice output; the browser tts tier is offered instead (features.tts=true, ttsEngines includes \"browser\")");
  } else if (!voice.elevenLabsKey) {
    log(`ELEVENLABS_API_KEY missing: vendor voice output through Deepgram Aura only (${resolvedAuraModel}), browser tts tier as the last resort`);
  }
  if (voice.elevenLabsKey) {
    const source = envFirst("VOICE_ID") ? "VOICE_ID" : envFirst("ELEVENLABS_VOICE_ID") ? "ELEVENLABS_VOICE_ID" : "default";
    log(`elevenlabs voice ${voice.voiceId ?? DEFAULT_VOICE_ID} (${source})`);
    log(
      voice.deepgramKey
        ? `tts: elevenlabs primary, deepgram ${resolvedAuraModel} fallback, browser tts tier last resort`
        : "tts: elevenlabs primary (no DEEPGRAM_API_KEY, so no Aura fallback), browser tts tier last resort",
    );
  }
  if (voice.deepgramKey) {
    const auraSource = envFirst("DEEPGRAM_TTS_MODEL") ? "DEEPGRAM_TTS_MODEL" : "default";
    log(`aura voice ${resolvedAuraModel} (${auraSource})`);
  }
  if (voice.deepgramKey && voice.elevenLabsKey) {
    log(`voice ON (deepgram ${describeSttModel("en")} for en, ${describeSttModel("tr")} for tr; elevenlabs both languages, aura en only, browser tts tier for the rest)`);
  }
  if (voice.modelId) log(`model override: ${voice.modelId}`);
  if (extraOrigins.size > 0) log(`extra ws origins: ${[...extraOrigins].join(", ")}`);
  // Vendor socket overrides are test hooks; say so loudly when one is in force, because the
  // matching API key travels to that host on every stream. An ignored one is logged by the hook.
  for (const name of VENDOR_URL_ENV) {
    const url = vendorUrlOverride(name, log);
    if (!url) continue;
    const key = name.startsWith("DEEPGRAM") ? "DEEPGRAM_API_KEY" : "ELEVENLABS_API_KEY";
    log(`vendor URL override in force: ${name}=${url} (${key} is sent to that host on every stream)`);
  }
});

function shutdown(signal: string): void {
  log(`${signal}: closing ${sessions.size} session(s)`);
  for (const s of sessions) s.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
