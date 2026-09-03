/**
 * Sentence chunker for streaming text -> TTS.
 *
 * Emits a chunk when one of `.?!` (optionally followed by a closing quote/bracket) is
 * followed by whitespace, or when the buffer exceeds 120 chars and contains a comma
 * (split after the last ", "). Text after a terminal punctuation mark that has not yet
 * been followed by whitespace stays buffered, so "3.5" and "HM-1042." at the end of a
 * delta are not split prematurely. A period after a list marker ("1. ", "options: 2. "),
 * a single letter ("plan B.") or a common abbreviation ("e.g.", "i.e.", "Mr.") is not a
 * sentence end either, so numbered option lists reach TTS as one chunk. `flush()`
 * returns whatever is left at end of turn.
 */

const SENTENCE_END = /[.?!]["'”’)\]]*\s/g;
/**
 * Tested against the buffer up to and including the candidate period. A 1-2 digit token is
 * a list marker only at the start of the buffer or after `: ; , (`, so "EUR 45." still cuts.
 */
const NOT_A_SENTENCE_END = /(?:(?:^|[:;,(]\s*)\d{1,2}|(?:^|\s)[a-z]|(?:^|\s)(?:e\.g|i\.e|mr|mrs|ms|dr|vs))\.$/i;
export const MAX_BUFFER_BEFORE_COMMA_SPLIT = 120;

export class SentenceChunker {
  private buf = "";

  /** Append streamed text; returns zero or more completed chunks in order. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) out.push(piece);
    }
    return out;
  }

  /** Return the remaining buffered text (trimmed) and reset. */
  flush(): string | undefined {
    const rest = this.buf.trim();
    this.buf = "";
    return rest.length > 0 ? rest : undefined;
  }

  get pending(): string {
    return this.buf;
  }

  private findCut(): number {
    SENTENCE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(this.buf)) !== null) {
      if (m[0][0] === "." && NOT_A_SENTENCE_END.test(this.buf.slice(0, m.index + 1))) continue;
      return m.index + m[0].length;
    }
    if (this.buf.length > MAX_BUFFER_BEFORE_COMMA_SPLIT) {
      const idx = this.buf.lastIndexOf(", ");
      if (idx > 0) return idx + 2;
    }
    return -1;
  }
}
