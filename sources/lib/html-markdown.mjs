/**
 * HTML → Markdown for feed bodies.
 *
 * Split out of `text.mjs` when that file outgrew the repo's per-file line
 * ratchet. The two halves do genuinely different jobs: `text.mjs` handles
 * strings — entities, ids, dates — while this walks a parsed document and
 * decides what structure survives into the stored document.
 *
 * **The output is Markdown that must PARSE.** The ingest door runs every body
 * through a Markdown gate and rejects what it cannot read, and a rejected
 * document is an error that holds the whole feed's cursor — so a malformed emit
 * here does not spoil one post, it stops the feed. Every escape and every
 * empty-element guard below exists for that reason.
 *
 * @module
 */

import { parse as parseHtmlDocument } from 'node-html-parser';
import { decodeHtmlEntities } from './text.mjs';

/** Elements whose content never belongs in the stored text. */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'head']);

/** Elements that end a paragraph: a blank line on both sides. */
const PARAGRAPH_TAGS = new Set(['p', 'blockquote', 'figure', 'table', 'ul', 'ol', 'dl']);

/** Heading tags to their ATX Markdown prefix. */
const HEADING_MARKERS = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '####',
  h5: '#####',
  h6: '######',
};

/** Elements that end a line: their content stands on its own line. */
const LINE_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'li',
  'tr',
  'dt',
  'dd',
  'figcaption',
]);

/** Inline emphasis tags and the Markdown marker each becomes. */
const EMPHASIS_MARKERS = {
  em: '*',
  i: '*',
  strong: '**',
  b: '**',
};

/** The blank-run or line boundary a block element contributes, if any. */
function blockBoundary(tag) {
  if (PARAGRAPH_TAGS.has(tag)) return '\n\n';
  if (LINE_TAGS.has(tag)) return '\n';
  return '';
}

/**
 * Render a childless element that maps to fixed output: `br`/`hr` breaks and
 * `img` alt text. Returns false when the tag is not one of them.
 */
function renderVoidElement(tag, node, parts) {
  switch (tag) {
    case 'br': {
      parts.push('\n');
      return true;
    }
    case 'hr': {
      parts.push('\n\n');
      return true;
    }
    case 'img': {
      const alt = (node.getAttribute('alt') || '').trim();
      if (alt) parts.push(`[Image: ${decodeHtmlEntities(alt)}]`);
      return true;
    }
    default: {
      return false;
    }
  }
}

/** Render each child of `node` into `parts`. */
function renderChildren(node, parts, inPre) {
  for (const child of node.childNodes) {
    renderNode(child, parts, inPre);
  }
}

/** Trim leading and trailing newlines only, keeping inner and other whitespace. */
function trimNewlines(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '\n') start++;
  while (end > start && value[end - 1] === '\n') end--;
  return value.slice(start, end);
}

/**
 * Escape the characters that would break a Markdown link if they appeared raw
 * in its text or its destination.
 *
 * Not cosmetic. The ingest door runs every inline body through a Markdown gate
 * and REJECTS one it cannot parse — and a rejected document is a per-document
 * error that HOLDS THE FEED'S CURSOR, deliberately, so a broken parser is loud
 * rather than silently polluting the corpus. So a title containing `]` or a URL
 * containing `)` does not degrade one document, it stops the feed advancing.
 *
 * @param {string} value - Raw link text or destination.
 * @param {boolean} isUrl - Escape for the `(...)` destination rather than the
 *   `[...]` label.
 * @returns {string} The escaped value.
 */
function escapeLinkPart(value, isUrl) {
  return isUrl
    ? value.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll(/\s/g, '%20')
    : value.replaceAll(/([[\]])/g, String.raw`\$1`);
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
function quoteLines(body) {
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
 * One `<a>` as Markdown: a link, an autolink, or bare text.
 *
 * @param {object} node - The anchor element.
 * @param {boolean} inPre - Whether we are inside a `<pre>` block.
 * @returns {string} The rendered link.
 */
function renderLink(node, inPre) {
  const href = (node.getAttribute('href') || '').trim();
  const label = [];
  renderChildren(node, label, inPre);
  // Link text is collapsed to a single line, the way established HTML-to-Markdown
  // converters do. A `<br>` inside an anchor otherwise emits a newline between
  // `[` and `]`; mdast happens to tolerate that today, and building on a
  // parser's tolerance for malformed input is how a feed breaks on a version
  // bump rather than on a change anyone made.
  const text = label.join('').replaceAll(/\s+/g, ' ').trim();
  // A link with no destination, or whose text IS the destination, adds only
  // noise as `[url](url)`.
  if (!href || !text) return text;
  if (text === href) return `<${escapeLinkPart(href, true)}>`;
  return `[${escapeLinkPart(text, false)}](${escapeLinkPart(href, true)})`;
}

/**
 * Render an element that wraps its children in Markdown syntax — a fenced code
 * block (`<pre>`), an inline code chip (`<code>`), an ATX heading (`<h1>`–`<h6>`),
 * or a bulleted list item (`<li>`). Returns false when `tag` is none of them, so
 * the caller falls back to plain block/inline handling.
 */
function renderWrappedElement(tag, node, parts, inPre) {
  // `<pre>` keeps its children's whitespace verbatim inside a fence, so the
  // reader renders it as code rather than run-together prose. Children are still
  // parsed so feeds' highlighting spans get stripped.
  if (tag === 'pre') {
    const code = [];
    renderChildren(node, code, true);
    const body = trimNewlines(code.join(''));
    parts.push(`\n\n\`\`\`\n${body}\n\`\`\`\n\n`);
    return true;
  }
  // Inline `<code>` becomes a backtick chip. Suppressed inside `<pre>`, where the
  // fence already sets the block as code and inner backticks would be noise.
  if (tag === 'code' && !inPre) {
    parts.push('`');
    renderChildren(node, parts, inPre);
    parts.push('`');
    return true;
  }
  // Headings become ATX Markdown so the reader sets them as headings rather than
  // dropping them into indistinguishable body prose.
  const heading = HEADING_MARKERS[tag];
  if (heading) {
    const inner = [];
    renderChildren(node, inner, inPre);
    const body = inner.join('').trim();
    // An EMPTY heading is dropped, not emitted as a bare `##`.
    //
    // Found by running this converter over eight live feeds: Bits About Money
    // ships `<h2 id></h2>` between sections, and a bare marker is rejected by
    // the ingest gate ("a producer emitted a bare heading with no text") — which
    // does not spoil one document, it holds the whole feed's cursor. Two of that
    // feed's fifteen posts hit it.
    if (!body) return true;
    parts.push(`\n\n${heading} ${body}\n\n`);
    return true;
  }
  // Links carry the href through as Markdown. Dropping it was the single
  // biggest fidelity loss in the RSS path: a link-heavy blog reduced to its
  // prose loses what it is ABOUT, and nothing downstream can recover the
  // destination once it is gone — not a re-render, not a reformatting pass,
  // because the href never reached the stored document at all.
  if (tag === 'a') {
    parts.push(renderLink(node, inPre));
    return true;
  }
  // Blockquotes keep their attribution. Flattened to a paragraph, a quotation
  // reads as the author's own words — in one Daring Fireball post a friend's
  // line became indistinguishable from Gruber's prose, which is a correctness
  // problem for any reader, human or model.
  if (tag === 'blockquote') {
    const inner = [];
    renderChildren(node, inner, inPre);
    const body = trimNewlines(inner.join('')).trim();
    if (body) parts.push(`\n\n${quoteLines(body)}\n\n`);
    return true;
  }
  // Emphasis, last and least. Kept minimal — `*` and `**` only — because every
  // marker emitted into prose is another chance to trip the ingest gate, and
  // the payoff here is presentational rather than semantic.
  const emphasis = EMPHASIS_MARKERS[tag];
  if (emphasis) {
    const inner = [];
    renderChildren(node, inner, inPre);
    const body = inner.join('');
    // Whitespace-only or empty emphasis would emit bare `**`, which reads as
    // literal asterisks rather than as markup.
    if (body.trim().length === 0) {
      parts.push(body);
      return true;
    }
    parts.push(`${emphasis}${body.trim()}${emphasis}`);
    return true;
  }
  // List items open on their own line with a bullet and take no trailing
  // boundary — the next item's opening (or the list's closing) provides it.
  if (tag === 'li') {
    parts.push('\n- ');
    renderChildren(node, parts, inPre);
    return true;
  }
  return false;
}

/**
 * Render one DOM node into `parts`. Inside `<pre>` text is kept verbatim
 * (code keeps its line breaks); elsewhere whitespace runs collapse to single
 * spaces, per HTML semantics. Text is entity-decoded twice because feed bodies
 * are HTML that was itself entity-encoded for XML embedding (`&amp;amp;` →
 * `&amp;` → `&`).
 */
function renderNode(node, parts, inPre) {
  if (node.nodeType === 3) {
    const text = decodeHtmlEntities(decodeHtmlEntities(node.text));
    parts.push(inPre ? text : text.replaceAll(/\s+/g, ' '));
    return;
  }
  if (node.nodeType !== 1) return; // comments etc.
  const tag = node.rawTagName?.toLowerCase() ?? '';
  if (DROP_TAGS.has(tag)) return;
  if (renderVoidElement(tag, node, parts)) return;
  if (renderWrappedElement(tag, node, parts, inPre)) return;

  const boundary = blockBoundary(tag);
  if (boundary) parts.push(boundary);
  renderChildren(node, parts, inPre);
  if (boundary) parts.push(boundary);
}

/**
 * Reduce an HTML (or already-plain) fragment to clean, lightweight Markdown:
 * headings as `#` lines, paragraphs separated by blank lines, list items as
 * `- ` lines, `<pre>` as a fenced code block and inline `<code>` as a backtick
 * span, `script`/`style` dropped, images reduced to their alt text, entities
 * decoded. Markup is parsed with a real HTML parser. The output is deliberately
 * minimal Markdown — enough structure for the reader, not a full
 * HTML-to-Markdown translation.
 */
export function htmlToText(html) {
  if (!html) return '';
  // A body that is *entirely* entity-escaped markup (no real tags) needs one
  // decode before parsing, or its tags would surface as literal text.
  const source =
    !html.includes('<') && /&lt;|&#60;|&#x3c;/i.test(html) ? decodeHtmlEntities(html) : html;
  // Already-plain text (no markup at all): keep its own line structure instead
  // of applying HTML whitespace collapsing.
  if (!source.includes('<')) {
    return decodeHtmlEntities(decodeHtmlEntities(source))
      .split('\n')
      .map((line) => line.replaceAll(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      .replaceAll(/\n{3,}/g, '\n\n')
      .trim();
  }
  // `pre` is NOT a raw-text block element here: its children must be parsed so
  // syntax-highlighting spans are stripped while `inPre` keeps the whitespace.
  const root = parseHtmlDocument(source, {
    blockTextElements: { script: true, style: true, noscript: true },
  });
  const parts = [];
  for (const child of root.childNodes) {
    renderNode(child, parts, false);
  }
  return (
    parts
      .join('')
      .split('\n')
      // Trailing spaces always go; a stray single leading space (an inline join
      // artifact) goes too, while deeper indentation (pre blocks) is kept.
      .map((line) => {
        const trimmed = line.trimEnd();
        return trimmed.startsWith(' ') && !trimmed.startsWith('  ') ? trimmed.slice(1) : trimmed;
      })
      .join('\n')
      .replaceAll(/\n{3,}/g, '\n\n') // cap consecutive blank lines
      .trim()
  );
}
