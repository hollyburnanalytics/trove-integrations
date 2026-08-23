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
import {
  asArray,
  atomLink,
  authorName,
  enclosureOf,
  hostOf,
  htmlPayload,
  nodeText,
  plainText,
  record,
  records,
} from './feed-nodes.ts';
import { decodeHtmlEntities } from './text.ts';
import type { FeedEnclosure, FeedItem } from './types.js';

/**
 * Extract a tag's text content from an XML fragment.
 * Handles CDATA and plain text. Tag names are treated as literals, not regex.
 *
 * A lightweight helper for adapters picking single fields out of small XML
 * fragments — full feed parsing goes through {@link parseRSS}.
 *
 * @param xml - The fragment to search.
 * @param tag - The tag name, treated as a literal.
 * @returns Its text content, or `''`.
 */
export function xmlText(xml: string, tag: string): string {
  const t = tag.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const m =
    xml.match(new RegExp(String.raw`<${t}(?:\s[^>]*)?><!\[CDATA\[([\s\S]*?)\]\]><\/${t}>`)) ||
    xml.match(new RegExp(String.raw`<${t}(?:\s[^>]*)?>([^<]*)<\/${t}>`));
  return m?.[1]?.trim() ?? '';
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

/**
 * The media file an RSS item points at: `<enclosure url type length>`. A
 * podcast episode's audio arrives this way (the element is how RSS 2.0 carries
 * an attached file at all). Feeds occasionally repeat the element — for a
 * low-bitrate alternate, or by mistake — so the first one with a URL wins,
 * matching how podcast clients read them.
 *
 * @param value - The item's `<enclosure>` node(s).
 * @returns The first with a URL.
 */
function rssEnclosure(value: unknown): FeedEnclosure | undefined {
  for (const node of asArray(value)) {
    const element = record(node);
    if (!element) continue;
    const url = String(element['@_url'] ?? '').trim();
    if (url) return enclosureOf(url, element['@_type'], element['@_length']);
  }
}

/**
 * The same, for Atom's `<link rel="enclosure" href type length>`.
 *
 * @param value - The entry's `<link>` node(s).
 * @returns The first enclosure link.
 */
function atomEnclosure(value: unknown): FeedEnclosure | undefined {
  for (const link of asArray(value)) {
    const element = record(link);
    if (element?.['@_rel'] !== 'enclosure') continue;
    const url = String(element['@_href'] ?? '').trim();
    if (url) return enclosureOf(url, element['@_type'], element['@_length']);
  }
}

/**
 * The same, for a JSON Feed item's first `attachments[]` entry.
 *
 * @param value - The item's `attachments` array.
 * @returns The first with a URL.
 */
function jsonFeedEnclosure(value: unknown): FeedEnclosure | undefined {
  for (const attachment of asArray(value)) {
    const element = record(attachment);
    if (!element) continue;
    const url = String(element.url ?? '').trim();
    if (url) return enclosureOf(url, element.mime_type, element.size_in_bytes);
  }
}

/**
 * Category labels: RSS text nodes and Atom `term` attributes, de-duplicated.
 *
 * @param value - The `<category>` node(s).
 * @returns The distinct labels, in document order.
 */
function categoryLabels(value: unknown): string[] {
  const labels: string[] = [];
  for (const category of asArray(value)) {
    const element = record(category);
    const label = element?.['@_term'] ? String(element['@_term']).trim() : nodeText(category);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Normalize one RSS 2.0 / RSS 1.0 `<item>`.
 *
 * @param item - The parsed item.
 * @param feedAuthor - The channel-level author, as a fallback.
 * @param feedTitle - The channel's own title.
 * @param feedNewUrl - Where the channel says it has moved.
 * @returns The normalized item.
 */
function rssItem(
  item: Record<string, unknown>,
  feedAuthor: string,
  feedTitle: string = '',
  feedNewUrl: string = '',
): FeedItem {
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
    enclosure: rssEnclosure(item.enclosure),
    feedTitle,
    feedNewUrl,
  };
}

/**
 * Normalize one Atom `<entry>`.
 *
 * @param entry - The parsed entry.
 * @param feedAuthor - The feed-level author, as a fallback.
 * @param feedHost - The publisher's own host, for link resolution.
 * @param feedTitle - The feed's own title.
 * @returns The normalized item.
 */
function atomEntry(
  entry: Record<string, unknown>,
  feedAuthor: string,
  feedHost: string = '',
  feedTitle: string = '',
): FeedItem {
  const link = atomLink(entry.link, feedHost);
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
    enclosure: atomEnclosure(entry.link),
    feedTitle,
  };
}

/**
 * Normalize one JSON Feed item (https://jsonfeed.org, 1.0 and 1.1).
 *
 * @param item - The parsed item.
 * @param feedAuthor - The feed-level author, as a fallback.
 * @param feedTitle - The feed's own title.
 * @returns The normalized item.
 */
function jsonFeedItem(
  item: Record<string, unknown>,
  feedAuthor: string,
  feedTitle: string = '',
): FeedItem {
  const link = typeof item.url === 'string' ? item.url : String(item.external_url ?? '');
  const contentHtml = typeof item.content_html === 'string' ? item.content_html : '';
  const contentText = typeof item.content_text === 'string' ? item.content_text : '';
  const summary = typeof item.summary === 'string' ? item.summary : '';
  const author =
    nodeText(record(asArray(item.authors)[0])?.name) ||
    nodeText(record(item.author)?.name) ||
    feedAuthor;
  return {
    title: typeof item.title === 'string' ? item.title : '',
    link,
    description: (summary || plainText(contentHtml) || contentText).slice(0, 1000),
    content: contentHtml,
    bodyHtml: contentHtml || contentText || summary,
    pubDate: String(item.date_published ?? item.date_modified ?? ''),
    author,
    guid: item.id === undefined || item.id === null ? link : String(item.id),
    categories: asArray(item.tags).filter((t) => typeof t === 'string'),
    enclosure: jsonFeedEnclosure(item.attachments),
    feedTitle,
  };
}

/**
 * Parse a JSON Feed document, or return undefined when the JSON is not one.
 *
 * @param text - The raw JSON document.
 * @returns Its items, if it is a JSON Feed.
 */
function parseJsonFeed(text: string): FeedItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const feed = record(parsed);
  if (!feed || !Array.isArray(feed.items)) return;
  const feedAuthor =
    nodeText(record(asArray(feed.authors)[0])?.name) || nodeText(record(feed.author)?.name);
  const feedTitle = typeof feed.title === 'string' ? feed.title : '';
  const fallback = feedAuthor || feedTitle;
  return records(feed.items).map((item) => jsonFeedItem(item, fallback, feedTitle));
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
 *  - `feedTitle` — the channel/feed `<title>`: the publication's own name,
 *    distinct from `author`. A podcast feed names the SHOW here while its items
 *    name the hosts, so a source adapter that must attribute to the show reads
 *    this rather than `author`. `''` for a bare fragment with no feed element.
 *  - `feedNewUrl` — the channel's `<itunes:new-feed-url>`: where the show says
 *    it has permanently moved to. `''` when the feed advertises no move, which
 *    is nearly always. RSS only — Atom and JSON Feed define no equivalent.
 *  - `enclosure` — the attached media file as `{ url, type, length? }`, or
 *    `undefined` when the item has none. RSS `<enclosure>`, Atom
 *    `<link rel="enclosure">`, JSON Feed `attachments[0]`. This is how a
 *    podcast feed carries its episode audio.
 *
 * @param text - The raw feed document (XML or JSON).
 * @returns Normalized items (empty for a feed with no items).
 * @throws {Error} When the document is not a recognizable feed — a syncing
 *   feed must fail loudly rather than report a healthy "0 new" forever.
 */
export function parseRSS(text: string): FeedItem[] {
  const trimmed = (text ?? '').trim();
  if (trimmed.startsWith('{')) {
    const items = parseJsonFeed(trimmed);
    if (items) return items;
    throw new Error('Unrecognized feed format: JSON document is not a JSON Feed');
  }
  return parseXmlFeed(trimmed);
}

/**
 * Parse an XML feed document (RSS 2.0, RSS 1.0/RDF, or Atom) into items.
 *
 * @param trimmed - The raw XML document.
 * @returns Its normalized items.
 * @throws {Error} When the document is not a recognizable feed.
 */
function parseXmlFeed(trimmed: string): FeedItem[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(trimmed);
  } catch (error) {
    throw new Error(
      `Unrecognized feed format: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // RSS 2.0 (<rss><channel>…), headerless <channel>, and RSS 1.0 (<rdf:RDF>,
  // where <item> elements sit beside <channel> at the RDF root).
  const channel = record(parsed.rss)?.channel ?? parsed.RDF ?? parsed.channel;
  if (channel) {
    const channelNode = record(
      parsed.RDF ? asArray(record(parsed.RDF)?.channel)[0] : asArray(channel)[0],
    );
    const feedTitle = nodeText(channelNode?.title);
    const feedAuthor =
      nodeText(channelNode?.creator) || authorName(channelNode?.author) || feedTitle;
    // `<itunes:new-feed-url>` — the podcast standard for a permanent move. The
    // namespace prefix is stripped by the parser (removeNSPrefix), so it
    // arrives as `new-feed-url`. Published by the show itself, which makes it
    // the most authoritative relocation signal available.
    const feedNewUrl = nodeText(channelNode?.['new-feed-url']);
    const items = records(channel).flatMap((c) => records(c.item));
    return items.map((item) => rssItem(item, feedAuthor, feedTitle, feedNewUrl));
  }

  // Atom <feed> documents and bare fragments.
  const feed = record(parsed.feed);
  if (feed || parsed.entry !== undefined) {
    const entries = records(feed ? feed.entry : parsed.entry);
    const feedTitle = nodeText(feed?.title);
    const feedAuthor = authorName(feed?.author) || feedTitle;
    // The publisher's own host, so a link blog's entries can be told apart from
    // the sites they point at. See `permalinkFor`.
    const feedHost = hostOf(atomLink(feed?.link));
    return entries.map((entry) => atomEntry(entry, feedAuthor, feedHost, feedTitle));
  }
  if (parsed.item !== undefined) {
    return records(parsed.item).map((item) => rssItem(item, ''));
  }

  throw new Error('Unrecognized feed format: no RSS, Atom, or JSON Feed structure found');
}
