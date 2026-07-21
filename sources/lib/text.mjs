/**
 * Text helpers for feed source adapters: HTML entity decoding, tag stripping,
 * plain-text reduction, stable IDs, and safe date parsing. Feed bodies are
 * stored as structured plain text — paragraphs, list items, and code blocks
 * keep their boundaries — not as Markdown.
 */

import { createHash } from 'node:crypto';
import { parse as parseHtmlDocument } from 'node-html-parser';

/**
 * Strip HTML tags from a string by matching angle-bracketed sequences.
 * Uses a simple state-machine approach to avoid regex backtracking issues.
 */
export function stripHtmlTags(input) {
  let result = '';
  let inTag = false;
  for (const char of input) {
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
    } else if (!inTag) {
      result += char;
    }
  }
  return result;
}

/**
 * Generate a stable, collision-resistant ID from a string.
 */
export function stableId(prefix, input) {
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

/**
 * Safely parse a date string. Returns a valid ISO string or undefined.
 */
export function safeDate(dateString) {
  if (!dateString) return;
  const d = new Date(dateString);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The named entities feed bodies actually use, beyond the XML five. */
const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&middot;': '·',
};

/**
 * Decode common HTML entities (numeric plus the named ones feeds use).
 */
export function decodeHtmlEntities(string_) {
  let result = string_
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  return result.replaceAll('&amp;', '&'); // amp last so we don't double-decode
}

/** Elements whose content never belongs in the stored text. */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'head']);

/** Elements that end a paragraph: a blank line on both sides. */
const PARAGRAPH_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figure',
  'table',
  'ul',
  'ol',
  'dl',
]);

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

/** The blank-run or line boundary a block element contributes, if any. */
function blockBoundary(tag) {
  if (tag === 'pre' || PARAGRAPH_TAGS.has(tag)) return '\n\n';
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

  // List items open on their own line with a bullet and take no trailing
  // boundary — the next item's opening (or the list's closing) provides it.
  if (tag === 'li') {
    parts.push('\n- ');
    for (const child of node.childNodes) {
      renderNode(child, parts, inPre);
    }
    return;
  }
  const boundary = blockBoundary(tag);
  if (boundary) parts.push(boundary);
  for (const child of node.childNodes) {
    renderNode(child, parts, inPre || tag === 'pre');
  }
  if (boundary) parts.push(boundary);
}

/**
 * Reduce an HTML (or already-plain) fragment to clean, structured plain text:
 * paragraphs and headings separated by blank lines, list items as `- ` lines,
 * `<pre>` blocks verbatim, `script`/`style` dropped, images reduced to their
 * alt text, entities decoded. Markup is parsed with a real HTML parser; we
 * still deliberately emit plain text, not Markdown.
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
