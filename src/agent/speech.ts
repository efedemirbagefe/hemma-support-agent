/**
 * Spoken-text hygiene enforced in code, not prompt. Every assistant text delta passes
 * through `sanitizeSpoken` before it reaches the voice layer or the transcript, so a dash
 * the model produces anyway never reaches TTS.
 */

/** True when the text contains an em dash, an en dash, a spaced hyphen or a double hyphen. */
export function hasDash(text: string): boolean {
  return /[—–]|(?:^|\s)-(?:\s|$)|--/.test(text);
}

/**
 * Dashes become what a speaker would say: a digit range "9–13" becomes "9 to 13", any other
 * em/en dash, spaced hyphen or double hyphen becomes a comma. Hyphens inside words or codes
 * (HM-1042, 09-13, well-known) and negative numbers are untouched. Works per streaming delta:
 * a dash at the end of a delta still becomes a comma, and a following space is left alone.
 */
export function sanitizeSpoken(text: string): string {
  if (!text) return text;
  return text
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]+\s*/g, ", ")
    .replace(/\s*--+\s*/g, ", ")
    .replace(/(^|\s)-(?=\s|$)/g, "$1,")
    .replace(/(\S),\s+,\s+/g, "$1, ")
    .replace(/ ,/g, ",");
}
