/**
 * The position-aware output sink for the HTML → Markdown converter.
 *
 * One bit of state — *are we at the start of a line?* — is what separates a
 * converter that escapes correctly from one that guesses. Markdown's block
 * markers are positional: `#` opening a line is a heading and must be escaped
 * when it came from prose, while `#` mid-sentence is just a `#`. An array of
 * string fragments cannot answer that question without re-scanning everything
 * already emitted, so the fragments live behind this object instead.
 *
 * It also owns the two joins that only make sense at the seam between
 * fragments: collapsing repeated whitespace across text nodes, and merging an
 * emphasis span with the one that just closed.
 *
 * @module
 */

import { escapeText } from './markdown-emit.mjs';

/**
 * A sink for rendered fragments that knows whether it is at the start of a line.
 *
 * That one bit is why this is an object rather than an array. Escaping is
 * position-dependent — `#` opening a line is a heading and must be escaped, `#`
 * mid-sentence is a `#` and must not be — and a plain `parts.push()` cannot tell
 * the difference without re-scanning everything already emitted.
 *
 * @param {string} [seed] - What to treat as already emitted, so the first
 *   fragment escapes as though it opened a line.
 * @returns {import('./types.d.ts').MarkdownSink} The sink.
 */
export function createSink(seed = '\n') {
  /** @type {string[]} */
  const parts = [];
  /** @type {string | undefined} */
  let last = seed;
  return {
    /**
     * Emit already-rendered Markdown verbatim.
     *
     * @param {string} value - The fragment.
     */
    raw(value) {
      if (!value) return;
      parts.push(value);
      last = value.at(-1);
    },
    /**
     * Emit source text, escaped for its position.
     *
     * @param {string} value - The text.
     */
    text(value) {
      if (!value) return;
      // Collapse a space that follows a space or a line break. Each whitespace
      // run between tags is its own text node collapsing to one space, so a
      // pretty-printed source — `<picture>`, newline, indent, `<source>`,
      // newline, indent, `<img>` — contributes one space PER GAP and opens the
      // line at column ten. mdast reads four leading spaces as an indented code
      // block, so a caption arrives in the corpus fenced as source code. 65
      // bodies in the audit corpus did exactly that.
      const collapsed = last === '\n' || last === ' ' ? value.replace(/^ +/, '') : value;
      if (!collapsed) return;
      parts.push(escapeText(collapsed, last === '\n'));
      last = collapsed.at(-1);
    },
    /**
     * Whether the next emit would begin a line.
     *
     * @returns {boolean} True at the start of a line.
     */
    atLineStart() {
      return last === '\n';
    },
    /**
     * Absorb an immediately preceding emphasis span using the same marker, so
     * the caller can continue it instead of opening a second one.
     *
     * `<strong>a</strong><strong>b</strong>` — two spans with nothing between
     * them, which real feeds emit constantly when a CMS splits a bold run around
     * a deleted element — otherwise becomes `**a****b**`. That is not two bold
     * runs to a Markdown parser: it reads as bold text containing four literal
     * asterisks, and the gate's re-serialization writes them back out as
     * `**a\*\*\*\*b**`, so characters that were never in the source become part
     * of the stored prose. Merging emits `**ab**`, which is what the HTML meant.
     *
     * @param {string} marker - The emphasis marker about to be opened.
     * @returns {boolean} True when the previous span was absorbed.
     */
    mergeEmphasis(marker) {
      const tail = parts.at(-1);
      if (!tail?.endsWith(marker)) return false;
      const before = tail.slice(0, -marker.length);
      // A longer run of markers is a different span (`***` closing bold-italic),
      // and an empty remainder had no content to merge with.
      if (before.endsWith('*') || !before.trim()) return false;
      parts[parts.length - 1] = before;
      last = before.at(-1);
      return true;
    },
    /**
     * Everything emitted so far, joined.
     *
     * @returns {string} The rendered Markdown.
     */
    toString() {
      return parts.join('');
    },
  };
}
