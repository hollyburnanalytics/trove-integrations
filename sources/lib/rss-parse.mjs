/**
 * Feed parsing for source adapters: normalize any of the four wire formats a
 * subscribable feed actually ships in — RSS 2.0, RSS 1.0 (RDF), Atom
 * (including namespace-prefixed documents like HBR's `<ns6:entry>`), and JSON
 * Feed — into one item shape.
 *
 * Built on fast-xml-parser rather than regexes so namespace prefixes,
 * attributed tags, CDATA placement, and entity encoding are handled by a real
 * XML parser. HTML payload fields (`description`, `content:encoded`, Atom
 * `content`/`summary`) are declared as stop-nodes: their inner markup is
 * returned as a raw string instead of being parsed as XML, so item bodies
 * survive whether they arrive CDATA-wrapped, entity-escaped, or inline.
 */

import { XMLParser } from 'fast-xml-parser';
import { decodeHtmlEntities, stripHtmlTags } from './text.mjs';

/**
 * Extract a tag's text content from an XML fragment.
 * Handles CDATA and plain text. Tag names are treated as literals, not regex.
 *
 * A lightweight helper for adapters picking single fields out of small XML
 * fragments — full feed parsing goes through {@link parseRSS}.
 */
export function xmlText(xml, tag) {
  const t = tag.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const m =
    xml.match(new RegExp(String.raw`<${t}(?:\s[^>]*)?><!\[CDATA\[([\s\S]*?)\]\]><\/${t}>`)) ||
    xml.match(new RegExp(String.raw`<${t}(?:\s[^>]*)?>([^<]*)<\/${t}>`));
  return m ? m[1].trim() : '';
}

/**
 * The fields whose payload is HTML, not XML structure. Declared as stop-nodes
 * so fast-xml-parser hands back their inner markup verbatim. `*.encoded` is
 * `content:encoded` after namespace-prefix removal; `*.content` covers Atom
 * `<content>` in all three of its type variants (text/html/xhtml).
 */
const STOP_NODES = ['*.description', '*.encoded', '*.content', '*.summary'];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  cdataPropName: '#cdata',
  textNodeName: '#text',
  // Keep every value a string: item ids like "007" and dates must not become
  // numbers, and `parseTagValue` coercion would also mangle guids.
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  stopNodes: STOP_NODES,
});

/** Normalize a maybe-missing / maybe-scalar / maybe-array value to an array. */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Flatten a parsed node to its text: strings pass through; element objects
 * yield their CDATA/text parts; nested markup (Atom `type="xhtml"` bodies that
 * escaped the stop-node net) collapses to its string leaves in document order.
 * Attributes (`@_*` keys) never contribute.
 */
function nodeText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? firstNodeText(value) : elementNodeText(value);
}

/** The first non-empty text among repeated sibling elements. */
function firstNodeText(values) {
  for (const entry of values) {
    const text = nodeText(entry);
    if (text) return text;
  }
  return '';
}

/** Text of a parsed element object: CDATA/text parts, else its string leaves. */
function elementNodeText(value) {
  const cdata = nodeText(value['#cdata']);
  const text = nodeText(value['#text']);
  if (cdata || text) return `${cdata}${text}`.trim();
  const parts = [];
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('@_')) continue;
    const childText = nodeText(child);
    if (childText) parts.push(childText);
  }
  return parts.join(' ').trim();
}

/**
 * A stop-node's raw payload: the inner markup as a string, with a wrapping
 * CDATA section unwrapped. Attributed stop-nodes come back as
 * `{ '#text': raw, '@_type': … }`; bare ones as plain strings.
 */
function htmlPayload(value) {
  let raw = '';
  if (typeof value === 'string') raw = value;
  else if (typeof value === 'object' && value !== null) raw = nodeText(value);
  const trimmed = raw.trim();
  const cdata = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1].trim() : trimmed;
}

/** Plain-text form of an HTML payload: decoded, tag-stripped, whitespace-collapsed. */
function plainText(html) {
  return stripHtmlTags(decodeHtmlEntities(decodeHtmlEntities(html)))
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve an Atom link set: prefer `rel="alternate"`, then any link with an
 * `href`, then a link carried as element text (RSS-style).
 */
function atomLink(value) {
  const links = asArray(value);
  const withHref = links.filter((l) => typeof l === 'object' && l !== null && l['@_href']);
  const alternate = withHref.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate');
  const chosen = alternate ?? withHref[0];
  if (chosen) return String(chosen['@_href']).trim();
  return nodeText(value);
}

/** An author node's name: `<author><name>…</name></author>` or bare text. */
function authorName(value) {
  for (const author of asArray(value)) {
    const name =
      typeof author === 'object' && author !== null && author.name !== undefined
        ? nodeText(author.name)
        : nodeText(author);
    if (!name) continue;
    // RSS 2.0 <author> is an email address ("a@b.com (Name)") — extract the
    // parenthesized display name when present, and never store a bare email.
    const open = name.indexOf('(');
    const close = name.indexOf(')', open + 1);
    if (open !== -1 && close > open + 1) return name.slice(open + 1, close).trim();
    if (name.includes('@') && !name.includes(' ')) continue;
    return name;
  }
  return '';
}

/** Category labels: RSS text nodes and Atom `term` attributes, de-duplicated. */
function categoryLabels(value) {
  const labels = [];
  for (const category of asArray(value)) {
    const label =
      typeof category === 'object' && category !== null && category['@_term']
        ? String(category['@_term']).trim()
        : nodeText(category);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Normalize one RSS 2.0 / RSS 1.0 `<item>`. */
function rssItem(item, feedAuthor) {
  const descriptionHtml = htmlPayload(item.description);
  const contentHtml = htmlPayload(item.encoded); // <content:encoded>
  const link = atomLink(item.link);
  return {
    title: nodeText(item.title),
    link,
    description: plainText(descriptionHtml),
    content: contentHtml,
    bodyHtml: contentHtml || descriptionHtml,
    pubDate: nodeText(item.pubDate) || nodeText(item.date), // dc:date (RDF)
    author: nodeText(item.creator) || authorName(item.author) || feedAuthor,
    guid: nodeText(item.guid) || link,
    categories: categoryLabels(item.category),
  };
}

/** Normalize one Atom `<entry>`. */
function atomEntry(entry, feedAuthor) {
  const link = atomLink(entry.link);
  const contentHtml = htmlPayload(entry.content);
  const summaryHtml = htmlPayload(entry.summary);
  return {
    title: nodeText(entry.title),
    link,
    description: plainText(summaryHtml || contentHtml).slice(0, 1000),
    content: decodeHtmlEntities(contentHtml),
    bodyHtml: contentHtml || summaryHtml,
    pubDate: nodeText(entry.published) || nodeText(entry.updated),
    author: authorName(entry.author) || feedAuthor,
    guid: nodeText(entry.id) || link,
    categories: categoryLabels(entry.category),
  };
}

/** Normalize one JSON Feed item (https://jsonfeed.org, 1.0 and 1.1). */
function jsonFeedItem(item, feedAuthor) {
  const link = typeof item.url === 'string' ? item.url : (item.external_url ?? '');
  const contentHtml = typeof item.content_html === 'string' ? item.content_html : '';
  const contentText = typeof item.content_text === 'string' ? item.content_text : '';
  const summary = typeof item.summary === 'string' ? item.summary : '';
  const author = item.authors?.[0]?.name ?? item.author?.name ?? (feedAuthor || undefined);
  return {
    title: typeof item.title === 'string' ? item.title : '',
    link,
    description: (summary || plainText(contentHtml) || contentText).slice(0, 1000),
    content: contentHtml,
    bodyHtml: contentHtml || contentText || summary,
    pubDate: item.date_published ?? item.date_modified ?? '',
    author: author ?? '',
    guid: item.id !== undefined && item.id !== null ? String(item.id) : link,
    categories: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [],
  };
}

/** Parse a JSON Feed document, or return undefined when the JSON is not one. */
function parseJsonFeed(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return;
  const feedAuthor = parsed.authors?.[0]?.name ?? parsed.author?.name ?? '';
  const fallback = feedAuthor || (typeof parsed.title === 'string' ? parsed.title : '');
  return parsed.items.map((item) => jsonFeedItem(item, fallback));
}

/**
 * Parse a feed document into normalized items.
 *
 * Accepts RSS 2.0, RSS 1.0 (RDF), Atom (namespace prefixes stripped, so
 * `<ns6:entry>` parses like `<entry>`), and JSON Feed. Also accepts bare
 * `<item>`/`<entry>` fragments, which tests and fixtures use.
 *
 * Each item carries:
 *  - `title`, `link`, `guid`, `pubDate`, `categories`
 *  - `description` — plain-text summary (Atom/JSON capped at 1000 chars)
 *  - `content` — the explicit full-body field only (`content:encoded` / Atom
 *    `<content>` / JSON `content_html`), empty when the feed has none
 *  - `bodyHtml` — the best available body as raw HTML: `content`, falling
 *    back to the raw description/summary markup. **Adapters that want the
 *    fullest text should render this.**
 *  - `author` — item author, falling back to the feed-level author, then the
 *    feed title (so single-author blogs attribute correctly even when items
 *    carry no author)
 *
 * @param {string} text - The raw feed document (XML or JSON).
 * @returns {Array<object>} Normalized items (empty for a feed with no items).
 * @throws {Error} When the document is not a recognizable feed — a syncing
 *   feed must fail loudly rather than report a healthy "0 new" forever.
 */
export function parseRSS(text) {
  const trimmed = (text ?? '').trim();
  if (trimmed.startsWith('{')) {
    const items = parseJsonFeed(trimmed);
    if (items) return items;
    throw new Error('Unrecognized feed format: JSON document is not a JSON Feed');
  }
  return parseXmlFeed(trimmed);
}

/** Parse an XML feed document (RSS 2.0, RSS 1.0/RDF, or Atom) into items. */
function parseXmlFeed(trimmed) {
  let parsed;
  try {
    parsed = xmlParser.parse(trimmed);
  } catch (error) {
    throw new Error(`Unrecognized feed format: ${error.message}`);
  }

  // RSS 2.0 (<rss><channel>…), headerless <channel>, and RSS 1.0 (<rdf:RDF>,
  // where <item> elements sit beside <channel> at the RDF root).
  const channel = parsed.rss?.channel ?? parsed.RDF ?? parsed.channel;
  if (channel) {
    const channelNode = parsed.RDF ? asArray(parsed.RDF.channel)[0] : asArray(channel)[0];
    const feedAuthor =
      nodeText(channelNode?.creator) ||
      authorName(channelNode?.author) ||
      nodeText(channelNode?.title);
    const items = asArray(channel).flatMap((c) => asArray(c.item));
    return items.map((item) => rssItem(item, feedAuthor));
  }

  // Atom <feed> documents and bare fragments.
  const feed = parsed.feed;
  if (feed || parsed.entry !== undefined) {
    const entries = feed ? asArray(feed.entry) : asArray(parsed.entry);
    const feedAuthor = authorName(feed?.author) || nodeText(feed?.title);
    return entries.map((entry) => atomEntry(entry, feedAuthor));
  }
  if (parsed.item !== undefined) {
    return asArray(parsed.item).map((item) => rssItem(item, ''));
  }

  throw new Error('Unrecognized feed format: no RSS, Atom, or JSON Feed structure found');
}
