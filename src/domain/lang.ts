/**
 * Session language. Two values, chosen on the /ws upgrade URL (`lang=en|tr`) or switched with a
 * `{type:"lang"}` client message; the domain Session carries it so every tool result, spoken
 * summary and date label comes out in the language the customer is being served in.
 */
export const LANGS = ["en", "tr"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "en";

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** "tr", " TR ", "tr-TR" -> "tr"; anything else -> undefined (the caller decides the default). */
export function parseLang(value: unknown): Lang | undefined {
  if (typeof value !== "string") return undefined;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLang(base) ? base : undefined;
}
