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
 *
 * @param {string} xml - The fragment to search.
 * @param {string} tag - The tag name, treated as a literal.
 * @returns {string} Its text content, or `''`.
 */
export function xmlText(xml, tag) {
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
 * Normalize a maybe-missing / maybe-scalar / maybe-array value to an array.
 *
 * @param {unknown} value - A parsed node, or nothing.
 * @returns {unknown[]} Zero, one or many nodes.
 */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A parsed node as a keyed object, or undefined when it is not one.
 *
 * The parser's output is `any`-shaped by nature — this is the one place that
 * says so, instead of `typeof x === 'object' && x !== null` at nine call sites.
 *
 * @param {unknown} value - A parsed node.
 * @returns {Record<string, unknown> | undefined} Its properties, if it has any.
 */
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * The keyed-object nodes among `value`, skipping anything that is not one.
 *
 * @param {unknown} value - A parsed node, or a list of them.
 * @returns {Record<string, unknown>[]} The nodes that have properties.
 */
function records(value) {
  return asArray(value)
    .map((entry) => record(entry))
    .filter((entry) => entry !== undefined);
}

/**
 * Flatten a parsed node to its text: strings pass through; element objects
 * yield their CDATA/text parts; nested markup (Atom `type="xhtml"` bodies that
 * escaped the stop-node net) collapses to its string leaves in document order.
 * Attributes (`@_*` keys) never contribute.
 *
 * @param {unknown} value - A parsed node.
 * @returns {string} Its text.
 */
function nodeText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return firstNodeText(value);
  const node = record(value);
  return node ? elementNodeText(node) : '';
}

/**
 * The first non-empty text among repeated sibling elements.
 *
 * @param {unknown[]} values - The sibling nodes.
 * @returns {string} The first non-empty text, or `''`.
 */
function firstNodeText(values) {
  for (const entry of values) {
    const text = nodeText(entry);
    if (text) return text;
  }
  return '';
}

/**
 * Text of a parsed element object: CDATA/text parts, else its string leaves.
 *
 * @param {Record<string, unknown>} value - The element's properties.
 * @returns {string} Its text.
 */
function elementNodeText(value) {
  const cdata = nodeText(value['#cdata']);
  const text = nodeText(value['#text']);
  if (cdata || text) return `${cdata}${text}`.trim();
  /** @type {string[]} */
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
 *
 * @param {unknown} value - The stop-node's parsed value.
 * @returns {string} Its raw inner markup.
 */
function htmlPayload(value) {
  let raw = '';
  if (typeof value === 'string') raw = value;
  else if (typeof value === 'object' && value !== null) raw = nodeText(value);
  const trimmed = raw.trim();
  const cdata = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata?.[1]?.trim() ?? trimmed;
}

/**
 * Plain-text form of an HTML payload: decoded, tag-stripped, whitespace-collapsed.
 *
 * @param {string} html - The markup.
 * @returns {string} Its text.
 */
function plainText(html) {
  return stripHtmlTags(decodeHtmlEntities(decodeHtmlEntities(html)))
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve an Atom link set: prefer `rel="alternate"`, then any link with an
 * `href`, then a link carried as element text (RSS-style).
 *
 * @param {unknown} value - The entry's `<link>` node(s).
 * @param {string} [feedHost] - The publisher's own host, for {@link permalinkFor}.
 * @returns {string} The resolved URL, or `''`.
 */
function atomLink(value, feedHost = '') {
  const withHref = records(value).filter((l) => Boolean(l['@_href']));
  const alternate = withHref.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate');
  const chosen = alternate ?? withHref[0];
  if (!chosen) return nodeText(value);
  const href = String(chosen['@_href']).trim();
  return permalinkFor(withHref, href, feedHost);
}

/**
 * The item's permalink ON THE PUBLISHER'S OWN SITE, given the `alternate` href.
 *
 * A LINK BLOG inverts what `rel="alternate"` means. On Daring Fireball, a
 * linked-list item's `alternate` is the article Gruber is pointing AT, and the
 * permalink for his own post — the thing we actually stored, his commentary —
 * is carried as `rel="related"`. 39 of the 48 entries in that feed are this
 * shape, so four out of five Daring Fireball documents in the library opened
 * somebody else's website when you asked for the original.
 *
 * The rule is narrow on purpose: it fires only when `alternate` leaves the
 * publisher's host AND a sibling link returns to it. Across the rest of the
 * catalog's feeds — Simon Willison, Ben Evans, Benn Stancil — zero entries have
 * an off-site `alternate` and none carry `rel="related"` at all, so nothing else
 * changes. It is also deliberately not keyed to Daring Fireball: the convention
 * is the general one for link blogs, and a host comparison expresses the actual
 * rule where a source name would only encode where we first met it.
 *
 * Note this does NOT change document identity — that comes from Atom `<id>` —
 * so correcting a URL re-points existing documents rather than duplicating them.
 *
 * @param {Record<string, unknown>[]} links - The entry's `<link>` elements that carry an href.
 * @param {string} href - The chosen `alternate` href.
 * @param {string} feedHost - The publisher's own host, from the feed element.
 * @returns {string} The permalink to store as the document's URL.
 */
function permalinkFor(links, href, feedHost) {
  if (!feedHost || hostOf(href) === feedHost) return href;
  // `rel="related"` specifically, not merely "some other link on the same host".
  // Atom entries carry `replies`, `edit` and `hub` links that are also on the
  // publisher's host and are emphatically not the post — taking the first
  // same-host link would quietly send a reader to a comment feed. Requiring the
  // rel that link blogs actually use costs nothing (it is what all 39 Daring
  // Fireball entries carry) and cannot mistake a sibling for a permalink.
  const related = links.find(
    (l) => l['@_rel'] === 'related' && hostOf(String(l['@_href']).trim()) === feedHost,
  );
  return related ? String(related['@_href']).trim() : href;
}

/**
 * A URL's lowercase host, or '' when it has none we can read.
 *
 * @param {string} url - The URL to read.
 * @returns {string} Its host, `www.` stripped.
 */
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * An author node's name: `<author><name>…</name></author>` or bare text.
 *
 * @param {unknown} value - The `<author>` node(s).
 * @returns {string} A display name, or `''`.
 */
function authorName(value) {
  for (const author of asArray(value)) {
    const node = record(author);
    const name = node?.name === undefined ? nodeText(author) : nodeText(node.name);
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

/**
 * Normalize one enclosure's attributes. `type` is lowercased and stripped of
 * any MIME parameters so callers can test it with a plain prefix comparison;
 * `length` is omitted unless the feed gave a positive byte count.
 *
 * @param {string} url - The enclosure's URL.
 * @param {unknown} type - Its declared MIME type, with any parameters.
 * @param {unknown} length - Its declared byte count.
 * @returns {import('./types.d.ts').FeedEnclosure} The normalized enclosure.
 */
function enclosureOf(url, type, length) {
  const bytes = Number.parseInt(String(length ?? ''), 10);
  /** @type {import('./types.d.ts').FeedEnclosure} */
  const enclosure = {
    url,
    type: (String(type ?? '').split(';')[0] ?? '').trim().toLowerCase(),
  };
  if (Number.isFinite(bytes) && bytes > 0) enclosure.length = bytes;
  return enclosure;
}

/**
 * The media file an RSS item points at: `<enclosure url type length>`. A
 * podcast episode's audio arrives this way (the element is how RSS 2.0 carries
 * an attached file at all). Feeds occasionally repeat the element — for a
 * low-bitrate alternate, or by mistake — so the first one with a URL wins,
 * matching how podcast clients read them.
 *
 * @param {unknown} value - The item's `<enclosure>` node(s).
 * @returns {import('./types.d.ts').FeedEnclosure | undefined} The first with a URL.
 */
function rssEnclosure(value) {
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
 * @param {unknown} value - The entry's `<link>` node(s).
 * @returns {import('./types.d.ts').FeedEnclosure | undefined} The first enclosure link.
 */
function atomEnclosure(value) {
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
 * @param {unknown} value - The item's `attachments` array.
 * @returns {import('./types.d.ts').FeedEnclosure | undefined} The first with a URL.
 */
function jsonFeedEnclosure(value) {
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
 * @param {unknown} value - The `<category>` node(s).
 * @returns {string[]} The distinct labels, in document order.
 */
function categoryLabels(value) {
  /** @type {string[]} */
  const labels = [];
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
 * @param {Record<string, unknown>} item - The parsed item.
 * @param {string} feedAuthor - The channel-level author, as a fallback.
 * @param {string} [feedTitle] - The channel's own title.
 * @param {string} [feedNewUrl] - Where the channel says it has moved.
 * @returns {import('./types.d.ts').FeedItem} The normalized item.
 */
function rssItem(item, feedAuthor, feedTitle = '', feedNewUrl = '') {
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
 * @param {Record<string, unknown>} entry - The parsed entry.
 * @param {string} feedAuthor - The feed-level author, as a fallback.
 * @param {string} [feedHost] - The publisher's own host, for link resolution.
 * @param {string} [feedTitle] - The feed's own title.
 * @returns {import('./types.d.ts').FeedItem} The normalized item.
 */
function atomEntry(entry, feedAuthor, feedHost = '', feedTitle = '') {
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
 * @param {Record<string, unknown>} item - The parsed item.
 * @param {string} feedAuthor - The feed-level author, as a fallback.
 * @param {string} [feedTitle] - The feed's own title.
 * @returns {import('./types.d.ts').FeedItem} The normalized item.
 */
function jsonFeedItem(item, feedAuthor, feedTitle = '') {
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
 * @param {string} text - The raw JSON document.
 * @returns {import('./types.d.ts').FeedItem[] | undefined} Its items, if it is a JSON Feed.
 */
function parseJsonFeed(text) {
  /** @type {unknown} */
  let parsed;
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
 * @param {string} text - The raw feed document (XML or JSON).
 * @returns {import('./types.d.ts').FeedItem[]} Normalized items (empty for a feed with no items).
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

/**
 * Parse an XML feed document (RSS 2.0, RSS 1.0/RDF, or Atom) into items.
 *
 * @param {string} trimmed - The raw XML document.
 * @returns {import('./types.d.ts').FeedItem[]} Its normalized items.
 * @throws {Error} When the document is not a recognizable feed.
 */
function parseXmlFeed(trimmed) {
  /** @type {Record<string, any>} */
  let parsed;
  try {
    parsed = xmlParser.parse(trimmed);
  } catch (error) {
    throw new Error(
      `Unrecognized feed format: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // RSS 2.0 (<rss><channel>…), headerless <channel>, and RSS 1.0 (<rdf:RDF>,
  // where <item> elements sit beside <channel> at the RDF root).
  const channel = parsed.rss?.channel ?? parsed.RDF ?? parsed.channel;
  if (channel) {
    const channelNode = record(parsed.RDF ? asArray(parsed.RDF.channel)[0] : asArray(channel)[0]);
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
  const feed = parsed.feed;
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
