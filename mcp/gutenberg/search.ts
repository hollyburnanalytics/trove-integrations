/**
 * Full-text search helpers for search_inside: forgiving text folding (case-,
 * accent-, and punctuation-insensitive, whitespace-collapsing) with an offset
 * map back into the original text, plus the context-snippet builder.
 */

/**
 * Smart-punctuation variants — curly quotes, apostrophes, and the dash family —
 * grouped under the plain ASCII character they stand in for, so a quotation typed
 * on a keyboard matches a typeset source. Keyed by ASCII char → its variants.
 */
const SMART_PUNCTUATION: Record<string, string> = {
  "'": '‘’‚‛′',
  '"': '“”„‟″',
  '-': '‐‑‒–—―',
};

/** Fold one character for search: smart punctuation → ASCII, lower-case, drop diacritics. */
function foldChar(ch: string): string {
  for (const [ascii, variants] of Object.entries(SMART_PUNCTUATION)) {
    if (variants.includes(ch)) return ascii;
  }
  return ch.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Normalise text for forgiving full-text search — case-, accent-, and
 * punctuation-insensitive, with every run of whitespace collapsed to one space so
 * a quotation matches across the source's line breaks. Returns the folded string
 * and a map from each folded character back to its offset in the original text, so
 * a match can be reported — and re-read with get_excerpt — at its true position.
 */
export function foldForSearch(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) continue; // the loop bound guarantees this; satisfies noUncheckedIndexedAccess
    if (/\s/.test(ch)) {
      gap = folded.length > 0; // a separating space, emitted lazily before the next visible char
      continue;
    }
    if (gap) {
      folded += ' ';
      map.push(i);
      gap = false;
    }
    for (const c of foldChar(ch)) {
      folded += c;
      map.push(i);
    }
  }
  return { folded, map };
}

/** Build a context snippet around an original-text span, collapsing whitespace. */
export function snippetAround(text: string, start: number, end: number, context: number): string {
  const s = Math.max(0, start - context);
  const e = Math.min(text.length, end + context);
  const body = text.slice(s, e).replace(/\s+/g, ' ').trim();
  return `${s > 0 ? '…' : ''}${body}${e < text.length ? '…' : ''}`;
}
