/**
 * Markdown emission primitives: escaping, safe destinations, code spans, tables.
 *
 * Split from `html-markdown.mjs` so the tree walk stays a tree walk. Everything
 * here answers one question — *given a fragment of source text, what bytes are
 * safe to emit?* — and the answers are load-bearing rather than cosmetic.
 *
 * **What "safe" means here.** The backend re-serializes every accepted body from
 * its own Markdown AST (`admit.ts` stores `normalizeMarkdown().markdown`, not our
 * bytes), so cosmetic choices — which bullet character, `*` versus `_`, how many
 * blank lines — are canonicalized downstream and are not our problem. What IS our
 * problem is **structure**: if our output parses as a *different tree* than the
 * HTML meant, the backend faithfully canonicalizes the wrong tree, and nothing
 * further downstream can tell. That is the entire job of this module.
 *
 * @module
 */

/**
 * URL schemes allowed to survive into a Markdown destination.
 *
 * Everything else — `javascript:`, `vbscript:`, and `data:` above all — is
 * dropped to its link text. Two reasons, and the second is the one that bites:
 * stored bodies are rendered in the web app and fed to models, so an active
 * scheme is a live payload in a document that came from a stranger's feed; and a
 * `data:` URI carries its whole payload inline, which is how four bodies in the
 * audit corpus tripped the backend's "encoded blob, not prose" rejection — a
 * base64 image smuggled into the corpus inside a link destination.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp', 'ftps', 'tel', 'news', 'feed']);

/**
 * Characters that must never reach the stored body.
 *
 * C0/C1 controls (bar tab and newline), zero-width spaces and joiners, the BOM,
 * and the soft hyphen. CMS exports are full of them — 403 bodies in the audit
 * corpus carried at least one, and 46 were REJECTED outright by the backend's
 * "zero-width or control characters" check, which reads them as the signature of
 * broken text extraction. They are invisible, so nobody notices until a feed
 * stops advancing.
 */
// Decimal on purpose. The two linters in this repo disagree about hex literal
// casing — one demands `0x00ad`, the other `0x00AD` — so any hex spelling here
// fails one of them, and the only ways out are a suppression or a decimal
// literal. The names in the comments are what a reader needs anyway.
const ZERO_WIDTH = new Set([
  173, // U+00AD soft hyphen
  8203, // U+200B zero-width space
  8204, // U+200C zero-width non-joiner
  8205, // U+200D zero-width joiner
  8288, // U+2060 word joiner
  65_279, // U+FEFF BOM / zero-width no-break space
]);

/**
 * Is this code point invisible-but-fatal?
 *
 * Written as a predicate rather than a regex on purpose: a character class of
 * literal control characters is unreadable in source, unreviewable in a diff, and
 * trips the linter's `noControlCharactersInRegex` — which would then need a
 * suppression to say "the control characters are the point". Naming the ranges
 * costs three lines and needs no such excuse.
 */
function isRemovable(code) {
  if (code === 9 || code === 10) return false; // tab and newline are content
  if (code < 32 || (code >= 127 && code <= 159)) return true; // C0 and C1 controls
  if (code >= 8234 && code <= 8238) return true; // U+202A–U+202E bidi overrides
  return ZERO_WIDTH.has(code);
}

/** Strip characters that are invisible in a browser but fatal at the ingest gate. */
export function stripControlCharacters(value) {
  let out = '';
  for (const character of value) {
    if (!isRemovable(character.codePointAt(0))) out += character;
  }
  return out;
}

/**
 * Is this destination safe to emit as a Markdown link target?
 *
 * Scheme-relative (`//host/path`) and site-relative (`/path`, `./path`) URLs have
 * no scheme to check and are allowed through.
 */
export function isSafeUrl(href) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  return scheme ? SAFE_SCHEMES.has(scheme[1].toLowerCase()) : true;
}

/**
 * Escape the characters that would break a Markdown link if they appeared raw
 * in its text or its destination.
 *
 * Not cosmetic. The ingest door runs every body through a Markdown gate and
 * REJECTS one it cannot parse — and a rejected document is a per-document error
 * that HOLDS THE FEED'S CURSOR, deliberately, so a broken parser is loud rather
 * than silently polluting the corpus. So a title containing `]` or a URL
 * containing `)` does not degrade one document, it stops the feed advancing.
 *
 * @param {string} value - Raw link text or destination.
 * @param {boolean} isUrl - Escape for the `(...)` destination rather than the
 *   `[...]` label.
 * @returns {string} The escaped value.
 */
export function escapeLinkPart(value, isUrl) {
  return isUrl
    ? value.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll(/\s/g, '%20')
    : // Idempotent: source text reaching a label has already been escaped once on
      // its way through the sink, and escaping it twice turns `\[` into `\\[` —
      // a literal backslash followed by an unescaped bracket, which is both
      // wrong on the page and worse at the parser than doing nothing. The
      // lookbehind is what makes this safe to apply to a mix of already-escaped
      // text and raw markers emitted by the converter itself.
      value.replaceAll(/(?<!\\)([[\]])/g, String.raw`\$1`);
}

/**
 * Escape source text so it cannot be re-read as markup.
 *
 * Only the characters that change the PARSE are escaped, and `atLineStart`
 * decides which set applies. A `#` mid-sentence is a `#`; a `#` opening a line is
 * a heading, and a post whose prose begins "# 1 in a series" would otherwise
 * enter the corpus as an `<h1>` that its author never wrote. The same holds for
 * `>` (blockquote), `-`/`*`/`+` (bullets) and `1.` (ordered item).
 *
 * `<` is escaped whenever it looks like a tag, because the backend rejects a body
 * containing raw HTML outright — text discussing `<div>` reads to that gate as a
 * converter that failed to do its job.
 */
export function escapeText(value, atLineStart) {
  const inline = value
    .replaceAll('\\', '\\\\')
    .replaceAll(/([[\]`])/g, String.raw`\$1`)
    .replaceAll(/<(?=[a-zA-Z/!?])/g, String.raw`\<`);
  return atLineStart ? inline.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, String.raw`$1\$2`) : inline;
}

/**
 * Wrap text in a backtick code span whose fence is longer than any run inside it.
 *
 * A fixed single backtick is wrong whenever the code contains one — 621 bodies in
 * the audit corpus contain backticks inside code, JavaScript template literals
 * mostly, and each one closed its span early and left the rest of the line as
 * prose. CommonMark's own rule is a fence longer than the longest inner run, plus
 * a space of padding when the content itself starts or ends with a backtick.
 */
export function codeSpan(body) {
  if (!body) return '';
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
}

/**
 * Prefix every line of a rendered fragment with `> `.
 *
 * Applied to the CHILDREN'S rendered output rather than wrapped around it,
 * because a blockquote's own paragraphs and nested quotes each need the marker
 * — a single leading `> ` would quote the first line and silently drop the rest
 * back into body prose, which is the bug this whole change exists to fix.
 *
 * @param {string} body - The rendered children.
 * @returns {string} The quoted block.
 */
export function quoteLines(body) {
  return (
    body
      // Collapse the blank runs FIRST. The outer pass caps consecutive newlines,
      // but by then every blank line inside a quote is a `>` and no longer looks
      // blank to it — a two-paragraph quotation would keep three empty `>` lines
      // between its halves.
      .replaceAll(/\n{2,}/g, '\n\n')
      .split('\n')
      .map((line) => (line.length > 0 ? `> ${line}` : '>'))
      .join('\n')
  );
}

/**
 * Flatten a fragment for a context that cannot hold block structure — link text
 * and table cells.
 *
 * A heading or bullet nested inside an anchor is legal HTML and appears in real
 * feeds (77 bodies in the audit corpus put an `<h4>` inside an `<a>`). Emitted
 * literally it produces `[#### Title](url)`, which parses as a link whose text
 * happens to start with hashes — not a heading, not what the source meant, and
 * impossible to correct downstream.
 */
export function flattenInline(body) {
  return (
    body
      // Every quantifier here is bounded and matches only horizontal whitespace.
      // The obvious `^\s*(#{1,6}\s+|…)` is ambiguous under the `m` flag, because
      // `\s` matches the newline that `^` just anchored to — so the engine can
      // split one run of whitespace between the two groups many ways and
      // backtracks super-linearly on a long line of spaces. A feed controls that
      // input, which makes it a denial-of-service shape rather than a slow test.
      .replaceAll(/^[ \t]{0,8}(#{1,6}|[*+-]|\d{1,9}[.)])[ \t]+/gm, '')
      .replaceAll(/^[ \t]{0,8}>[ \t]?/gm, '')
      .replaceAll(/\s+/g, ' ')
      .trim()
  );
}

/** One table cell, flattened and pipe-escaped, never empty. */
function tableCell(value) {
  // A pipe inside a cell would open a column the header row never declared, so
  // the row's width stops matching and the whole table degrades to prose.
  return flattenInline(value).replaceAll('|', String.raw`\|`) || ' ';
}

/**
 * Render a matrix of already-inline cells as a GFM table.
 *
 * Returns undefined for a table with no usable rows, so the caller can fall back
 * to ordinary block rendering rather than emit an empty grid.
 *
 * Ragged rows are padded rather than rejected: a feed that opens a `<table>` for
 * layout has no obligation to keep its column count, and the alternative to
 * padding is welding two cells into one word. 21 bodies in the audit corpus did
 * exactly that before this existed — `<td>Launch date</td><td>September 2026</td>`
 * arrived in the corpus as `Launch dateSeptember 2026`, which is not a formatting
 * loss but a fabricated string that never appeared in the source.
 */
export function renderTable(rows) {
  const usable = rows.filter((row) => row.length > 0);
  if (usable.length === 0) return;
  const width = Math.max(...usable.map((row) => row.length));
  const line = (row) =>
    `| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? '')).join(' | ')} |`;
  const [header, ...body] = usable;
  const divider = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [line(header), divider, ...body.map((row) => line(row))].join('\n');
}
