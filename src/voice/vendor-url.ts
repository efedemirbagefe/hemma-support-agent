/**
 * Test hooks for the vendor sockets: DEEPGRAM_WS_URL (listen), DEEPGRAM_SPEAK_WS_URL (Aura) and
 * ELEVENLABS_WS_URL point a client at a mock server. Every one of these sockets carries an API
 * key in its headers, so an override is honoured only when it points at this machine (loopback)
 * or when ALLOW_VENDOR_URL_OVERRIDE=1 says so explicitly. Anything else (a stray value copied
 * from someone's .env, a typo) is ignored and logged once, and the real vendor host is used.
 * server.ts lists every override in force at startup.
 */

export const VENDOR_URL_ENV = ["DEEPGRAM_WS_URL", "DEEPGRAM_SPEAK_WS_URL", "ELEVENLABS_WS_URL"] as const;
export type VendorUrlEnv = (typeof VENDOR_URL_ENV)[number];
export const ALLOW_VENDOR_URL_OVERRIDE_ENV = "ALLOW_VENDOR_URL_OVERRIDE";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const warned = new Set<string>();

function warnOnce(key: string, message: string, log: (msg: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  log(message);
}

/** True when overrides to any host are allowed (`ALLOW_VENDOR_URL_OVERRIDE=1`). */
export function vendorUrlOverrideAllowedAnywhere(): boolean {
  return (process.env[ALLOW_VENDOR_URL_OVERRIDE_ENV] ?? "").trim() === "1";
}

/**
 * The override for `name` when it is set and allowed, else undefined. The reason an override
 * is ignored is logged once per value (default: stderr).
 */
export function vendorUrlOverride(name: VendorUrlEnv, log: (msg: string) => void = (m) => console.error(`[voice] ${m}`)): string | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return undefined;
  const key = `${name}=${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    warnOnce(key, `${key} ignored: not a URL; the real vendor host is used`, log);
    return undefined;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    warnOnce(key, `${key} ignored: not a ws:// or wss:// URL; the real vendor host is used`, log);
    return undefined;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && !vendorUrlOverrideAllowedAnywhere()) {
    warnOnce(
      key,
      `${key} ignored: not a loopback host and ${ALLOW_VENDOR_URL_OVERRIDE_ENV}=1 is not set (the API key would be sent there); the real vendor host is used`,
      log,
    );
    return undefined;
  }
  return raw;
}
