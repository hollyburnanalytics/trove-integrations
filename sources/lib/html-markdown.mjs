/**
 * HTML → Markdown for feed bodies.
 *
 * Split out of `text.mjs` when that file outgrew the repo's per-file line
 * ratchet. The two halves do genuinely different jobs: `text.mjs` handles
 * strings — entities, ids, dates — while this walks a parsed document and
 * decides what structure survives into the stored document.
 *
 * The walk is the only thing left here. Its three collaborators are separate
 * because each is a different kind of decision:
 *
 * - `html-prepare.mjs` — what the walker is handed, and the final tidy
 * - `markdown-sink.mjs` — where fragments go, and what "start of a line" means
 * - `markdown-emit.mjs` — what bytes are safe to emit for a given fragment
 *
 * **The output is Markdown that must PARSE, and parse as what the HTML MEANT.**
 * The ingest door runs every body through a Markdown gate and rejects what it
 * cannot read, and a rejected document is an error that holds the whole feed's
 * cursor — so a malformed emit here does not spoil one post, it stops the feed.
 * Worse than a rejection is an emit that parses as the *wrong* tree: the backend
 * stores its own re-serialization of what it parsed, so a misread structure is
 * canonicalized into the corpus and no later pass can tell it was ever wrong.
 *
 * See `README.md` in this directory for the supported subset, the known
 * degradations, and how the corpus audit behind them was run.
 *
 * @module
 */

import { parse as parseHtmlDocument } from 'node-html-parser';
import { decodeUntilMarkup, plainTextToMarkdown, tidy, unwrapCdata } from './html-prepare.mjs';
import {
  codeSpan,
  escapeLinkPart,
  escapeText,
  flattenInline,
  isSafeUrl,
  quoteLines,
  renderTable,
  stripControlCharacters,
} from './markdown-emit.mjs';
import { createSink } from './markdown-sink.mjs';
import { decodeHtmlEntities } from './text.mjs';

/** Elements whose content never belongs in the stored text. */
const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'head',
  'form',
  'button',
  'input',
  'select',
  'option',
  'audio',
  'video',
  'source',
]);

/** Elements that end a paragraph: a blank line on both sides. */
const PARAGRAPH_TAGS = new Set(['p', 'blockquote', 'figure', 'dl']);

/** Heading tags to their ATX Markdown prefix. */
/** @type {Record<string, string>} */
const HEADING_MARKERS = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '####',
  h5: '#####',
  h6: '######',
};

/**
 * Elements that end a line: their content stands on its own line.
 *
 * `li`, `tr`, `td` and `th` are here as a SAFETY NET, not as their normal path —
 * inside a list or table they are consumed by `renderList`/`tableMatrix`, which
 * render their children directly and never reach this table. They matter when
 * one appears ORPHANED, which feed fragments do constantly: a body that opens
 * mid-table, or an excerpt cut at `<li>`. Without an entry here they fall
 * through to inline handling and their text welds — `<td>Left</td><td>Right</td>`
 * becoming `LeftRight`, a string that never appeared in the source. Never
 * joining two separate runs of text outranks rendering any particular tag well.
 */
const LINE_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'dt',
  'dd',
  'figcaption',
  'li',
  'tr',
  'td',
  'th',
]);

/** Inline emphasis tags and the Markdown marker each becomes. */
/** @type {Record<string, string>} */
const EMPHASIS_MARKERS = { em: '*', i: '*', strong: '**', b: '**' };

/**
 * Render a fragment in isolation and return it as a string.
 *
 * `isAtBlockStart` seeds the sink's line position. It matters because a nested
 * render begins with a fresh sink, and a sink that believes it is at the start
 * of a line eats leading whitespace and escapes leading `#`. Correct for a list
 * item or a blockquote, wrong for a fragment spliced back INTO a line: the
 * space in `a<strong> </strong>b` is content, and swallowing it welds two words
 * into `ab`.
 * @param {import('node-html-parser').HTMLElement} node - The subtree to render.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 * @param {boolean} [isAtBlockStart] - Whether the output starts a block.
 */
function renderToString(node, context, isAtBlockStart = false) {
  const sink = createSink(isAtBlockStart ? '\n' : 'x');
  renderChildren(node, sink, context);
  return sink.toString();
}

/** Trim leading and trailing newlines only, keeping inner and other whitespace. */
/**
 * @param {string} value - A rendered fragment.
 */
function trimNewlines(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '\n') start++;
  while (end > start && value[end - 1] === '\n') end--;
  return value.slice(start, end);
}

/**
 * Render a childless element that maps to fixed output: `br`/`hr` breaks and
 * `img` alt text. Returns false when the tag is not one of them.
 * @param {string} tag - The element name, lowercased.
 * @param {import('node-html-parser').HTMLElement} node - The element.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 */
function renderVoidElement(tag, node, sink) {
  switch (tag) {
    case 'br': {
      sink.raw('\n');
      return true;
    }
    case 'hr': {
      sink.raw('\n\n');
      return true;
    }
    case 'img': {
      const alt = (node.getAttribute('alt') || '').trim();
      if (alt) sink.raw(`[Image: ${escapeText(decodeHtmlEntities(alt), false)}]`);
      return true;
    }
    default: {
      return false;
    }
  }
}

/** Render each child of `node` into `sink`. */
/**
 * @param {import('node-html-parser').HTMLElement} node - The parent whose children to walk.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function renderChildren(node, sink, context) {
  for (const child of node.childNodes) {
    renderNode(/** @type {import('node-html-parser').HTMLElement} */ (child), sink, context);
  }
}

/**
 * One `<a>` as Markdown: a link, an autolink, or bare text.
 *
 * @param {import('node-html-parser').HTMLElement} node - The anchor element.
 * @param {import('./types.d.ts').MarkdownContext} context - The render context.
 * @returns {string} The rendered link.
 */
function renderLink(node, context) {
  const href = stripControlCharacters((node.getAttribute('href') || '').trim());
  // Link text is flattened, the way established HTML-to-Markdown converters do.
  // A `<br>` inside an anchor otherwise emits a newline between `[` and `]`, and
  // a heading inside one emits `[#### Title]`; mdast happens to tolerate the
  // first today, and building on a parser's tolerance for malformed input is how
  // a feed breaks on a version bump rather than on a change anyone made.
  const text = flattenInline(renderToString(node, context));
  // A link with no destination, or whose text IS the destination, adds only
  // noise as `[url](url)`. An UNSAFE destination degrades to its text rather
  // than being dropped whole — the words are the source's, only the target is
  // refused.
  if (!href || !text || !isSafeUrl(href)) return text;
  if (text === href) return `<${escapeLinkPart(href, true)}>`;
  return `[${escapeLinkPart(text, false)}](${escapeLinkPart(href, true)})`;
}

/**
 * Render a `<ul>`/`<ol>` as an indented Markdown list.
 *
 * Ordered lists keep their numbers and nested lists keep their depth, both of
 * which the first version of this converter dropped: every `<ol>` came out as
 * `-` bullets (239 of the 246 ordered lists in the audit corpus lost their
 * numbering) and every nested list was flattened level with its parent (2,417
 * bodies). Neither loss is recoverable downstream — by the time the body is
 * stored, a numbered procedure is indistinguishable from an unordered one.
 * @param {string} tag - Either `ul` or `ol`.
 * @param {import('node-html-parser').HTMLElement} node - The list element.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function renderList(tag, node, sink, context) {
  const isOrdered = tag === 'ol';
  const start = Number(node.getAttribute('start') ?? '1');
  const depth = context.listDepth ?? 0;
  const inner = { ...context, listDepth: depth + 1 };
  const indent = '  '.repeat(depth);
  const lines = [];
  let ordinal = Number.isNaN(start) ? 1 : start;

  // The list's OWN items, wherever they sit beneath it. Scanning only direct
  // children looks right and silently loses everything: a `<ul>` whose items are
  // wrapped in a `<div>` — which real feeds emit — rendered as the empty string,
  // because the wrapper was not an `<li>` and so was skipped whole. The ancestor
  // check is what keeps a nested list's items out of its parent.
  const items = node.querySelectorAll('li').filter((li) => nearestAncestor(li, LIST_TAGS) === node);

  for (const child of items) {
    const body = trimNewlines(renderToString(child, inner, true)).trim();
    // An EMPTY item is skipped, not emitted as a bare `-`. 299 bodies in the
    // audit corpus contain one — the Guardian ships empty `<li>` as spacing —
    // and a marker with no content is a list item that says nothing.
    if (!body) continue;
    const marker = isOrdered ? `${ordinal}. ` : '- ';
    // Continuation lines align under the marker, or Markdown reads them as a new
    // block that ends the list.
    const pad = ' '.repeat(marker.length);
    const [head, ...rest] = body.split('\n');
    lines.push(
      [`${indent}${marker}${head}`, ...rest.map((line) => `${indent}${pad}${line}`)].join('\n'),
    );
    ordinal++;
  }
  if (lines.length > 0) sink.raw(`\n\n${lines.join('\n')}\n\n`);
}

/**
 * The nearest ancestor of `node` (inclusive of `node`'s parent) whose tag is in
 * `tags`, or undefined.
 *
 * Needed because `querySelectorAll` is unscoped: asking a `<table>` for its
 * `tr` returns the rows of every table NESTED inside it too, and asking a
 * `<ul>` for its `li` returns the items of inner lists. Both then get rendered
 * twice — once in the outer structure and once inside the cell or item that
 * contains them.
 * @param {import('node-html-parser').HTMLElement} node - Where to start looking.
 * @param {Set<string>} tags - The tag names to stop at.
 */
function nearestAncestor(node, tags) {
  for (let current = node.parentNode; current; current = current.parentNode) {
    const tag = current.rawTagName?.toLowerCase();
    if (tag && tags.has(tag)) return current;
  }
}

/** Tag sets used to scope a descendant search to its own container. */
const TABLE_TAGS = new Set(['table']);
const LIST_TAGS = new Set(['ul', 'ol']);

/** Collect a `<table>`'s own cells, in document order, as a matrix of text. */
/**
 * @param {import('node-html-parser').HTMLElement} node - The `<table>` element.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function tableMatrix(node, context) {
  return node
    .querySelectorAll('tr')
    .filter((row) => nearestAncestor(row, TABLE_TAGS) === node)
    .map((row) =>
      row
        .querySelectorAll('th,td')
        .filter((cell) => nearestAncestor(cell, TABLE_TAGS) === node)
        .map((cell) => renderToString(cell, { ...context, listDepth: 0, inTable: true })),
    );
}

/**
 * Render `<pre>`, `<code>`, headings, links, quotes, emphasis, lists, tables.
 *
 * @param {string} tag - The element name, lowercased.
 * @param {import('node-html-parser').HTMLElement} node - The element.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function renderWrappedElement(tag, node, sink, context) {
  // `<pre>` keeps its children's whitespace verbatim inside a fence, so the
  // reader renders it as code rather than run-together prose. Children are still
  // parsed so feeds' highlighting spans get stripped.
  if (tag === 'pre') {
    const body = trimNewlines(rawTextOf(node));
    // The fence has to outlast any backtick run inside, or a code sample that
    // itself shows a fence closes the block early and dumps the rest into prose.
    const longest = Math.max(0, ...(body.match(/`{3,}/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    sink.raw(`\n\n${fence}\n${body}\n${fence}\n\n`);
    return true;
  }
  if (tag === 'code') {
    sink.raw(codeSpan(rawTextOf(node).replaceAll(/\s+/g, ' ').trim()));
    return true;
  }
  const heading = HEADING_MARKERS[tag];
  if (heading) return renderHeading(heading, node, sink, context);
  // Links carry the href through as Markdown. Dropping it was the single
  // biggest fidelity loss in the RSS path: a link-heavy blog reduced to its
  // prose loses what it is ABOUT, and nothing downstream can recover the
  // destination once it is gone — not a re-render, not a reformatting pass,
  // because the href never reached the stored document at all.
  if (tag === 'a') {
    sink.raw(renderLink(node, context));
    return true;
  }
  // Blockquotes keep their attribution. Flattened to a paragraph, a quotation
  // reads as the author's own words — in one Daring Fireball post a friend's
  // line became indistinguishable from Gruber's prose, which is a correctness
  // problem for any reader, human or model.
  if (tag === 'blockquote') {
    const body = trimNewlines(renderToString(node, context, true)).trim();
    if (body) sink.raw(`\n\n${quoteLines(body)}\n\n`);
    return true;
  }
  if (tag === 'ul' || tag === 'ol') {
    renderList(tag, node, sink, context);
    return true;
  }
  // A table INSIDE a table cell is left to ordinary block rendering, which its
  // `tr`/`td` line boundaries turn into one line per cell. GFM tables cannot
  // nest, so the alternative is emitting a table's Markdown into a cell of
  // another one — where the pipes are then escaped, and a readable inner table
  // becomes `OUTER \| INNER \| \| --- \|`. Plain lines lose the grid; they do
  // not lose or invent a single word.
  if (tag === 'table' && !context.inTable) {
    const table = renderTable(tableMatrix(node, context));
    if (table) sink.raw(`\n\n${table}\n\n`);
    return true;
  }
  return renderEmphasis(tag, node, sink, context);
}

/** An ATX heading, or nothing when it has no text. */
/**
 * @param {string} marker - The `#` run for this level.
 * @param {import('node-html-parser').HTMLElement} node - The heading element.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function renderHeading(marker, node, sink, context) {
  const body = flattenInline(renderToString(node, context));
  // An EMPTY heading is dropped, not emitted as a bare `##`.
  //
  // Found by running this converter over eight live feeds: Bits About Money
  // ships `<h2 id></h2>` between sections, and a bare marker is rejected by the
  // ingest gate — which does not spoil one document, it holds the whole feed's
  // cursor. Two of that feed's fifteen posts hit it.
  if (body) sink.raw(`\n\n${marker} ${body}\n\n`);
  return true;
}

/**
 * Emphasis, last and least. Kept minimal — `*` and `**` only — because every
 * marker emitted into prose is another chance to trip the ingest gate, and the
 * payoff here is presentational rather than semantic.
 * @param {string} tag - The emphasis element name.
 * @param {import('node-html-parser').HTMLElement} node - The element.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function renderEmphasis(tag, node, sink, context) {
  const marker = EMPHASIS_MARKERS[tag];
  if (!marker) return false;
  const body = renderToString(node, context);
  // Whitespace-only or empty emphasis would emit bare `**`, which reads as
  // literal asterisks rather than as markup.
  if (body.trim().length === 0) {
    sink.raw(body);
    return true;
  }
  const merged = sink.mergeEmphasis(marker);
  sink.raw(`${merged ? '' : marker}${body.trim()}${marker}`);
  return true;
}

/** A node's text with entities decoded and control characters stripped. */
/**
 * @param {import('node-html-parser').HTMLElement} node - The element to read.
 */
function rawTextOf(node) {
  return stripControlCharacters(decodeHtmlEntities(decodeHtmlEntities(node.text)));
}

/** The blank-run or line boundary a block element contributes, if any. */
/**
 * @param {string} tag - An element name.
 */
function blockBoundary(tag) {
  if (PARAGRAPH_TAGS.has(tag)) return '\n\n';
  if (LINE_TAGS.has(tag)) return '\n';
  return '';
}

/**
 * Render one DOM node into `sink`.
 *
 * Whitespace runs in text collapse to single spaces, per HTML semantics. `<pre>`
 * never reaches here as a container — `renderWrappedElement` takes its text
 * whole, which is what keeps its line breaks — so there is no verbatim mode to
 * carry through the walk.
 * @param {import('node-html-parser').HTMLElement} node - The node to render.
 * @param {import('./types.d.ts').MarkdownSink} sink - Where the output goes.
 * @param {import('./types.d.ts').MarkdownContext} context - The walk state.
 */
function renderNode(node, sink, context) {
  if (node.nodeType === 3) {
    const text = rawTextOf(node);
    sink.text(text.replaceAll(/\s+/g, ' '));
    return;
  }
  if (node.nodeType !== 1) return; // comments etc.
  const tag = node.rawTagName?.toLowerCase() ?? '';
  if (DROP_TAGS.has(tag)) return;
  if (renderVoidElement(tag, node, sink)) return;
  if (renderWrappedElement(tag, node, sink, context)) return;

  const boundary = blockBoundary(tag);
  sink.raw(boundary);
  renderChildren(node, sink, context);
  sink.raw(boundary);
}

/**
 * Reduce an HTML (or already-plain) fragment to clean, lightweight Markdown:
 * headings as `#` lines, paragraphs separated by blank lines, ordered and
 * nested lists with their numbering and depth, `<pre>` as a fenced code block
 * and inline `<code>` as a backtick span, tables as GFM tables, links and
 * blockquotes preserved, `script`/`style` dropped, images reduced to their alt
 * text, entities decoded.
 *
 * The output is deliberately a SUBSET of Markdown — enough structure for the
 * reader, not a full HTML-to-Markdown translation. `README.md` in this directory
 * lists what is supported, what degrades, and how.
 * @param {string} html - The raw HTML body.
 */
export function htmlToText(html) {
  if (!html) return '';
  // A body that is *entirely* entity-escaped markup (no real tags) needs
  // decoding before parsing, or its tags would surface as literal text.
  const source = unwrapCdata(decodeUntilMarkup(html));
  // Already-plain text (no markup at all): keep its own line structure instead
  // of applying HTML whitespace collapsing.
  if (!source.includes('<')) return plainTextToMarkdown(source);
  // `pre` is NOT a raw-text block element here: its children must be parsed so
  // a feed's syntax-highlighting spans are stripped rather than emitted as text.
  const root = parseHtmlDocument(source, {
    blockTextElements: { script: true, style: true, noscript: true },
  });
  const sink = createSink();
  renderChildren(root, sink, { listDepth: 0, inTable: false });
  return tidy(sink.toString());
}
