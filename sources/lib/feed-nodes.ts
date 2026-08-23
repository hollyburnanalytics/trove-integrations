/**
 * Reading values out of a parsed feed node, whatever the format.
 *
 * fast-xml-parser and `JSON.parse` both hand back `unknown`-shaped trees whose
 * every field is optional, scalar-or-array, and sometimes an element node with
 * a `#text` child. These are the readers that turn one of those into a string,
 * a list, a URL or an enclosure — and they are shared because RSS, RDF, Atom
 * and JSON Feed differ in their *element names*, not in how a value is dug out
 * of a node.
 *
 * Split from {@link module:rss-parse} when that file outgrew the per-file line
 * limit: the format-specific item builders stayed there, these came here.
 *
 * @module
 */

import { decodeHtmlEntities, stripHtmlTags } from './text.ts';
import type { FeedEnclosure } from './types.js';

/**
 * Normalize a maybe-missing / maybe-scalar / maybe-array value to an array.
 *
 * @param value - A parsed node, or nothing.
 * @returns Zero, one or many nodes.
 */
export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A parsed node as a keyed object, or undefined when it is not one.
 *
 * The parser's output is `any`-shaped by nature — this is the one place that
 * says so, instead of `typeof x === 'object' && x !== null` at nine call sites.
 *
 * @param value - A parsed node.
 * @returns Its properties, if it has any.
 */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The keyed-object nodes among `value`, skipping anything that is not one.
 *
 * @param value - A parsed node, or a list of them.
 * @returns The nodes that have properties.
 */
export function records(value: unknown): Record<string, unknown>[] {
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
 * @param value - A parsed node.
 * @returns Its text.
 */
export function nodeText(value: unknown): string {
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
 * @param values - The sibling nodes.
 * @returns The first non-empty text, or `''`.
 */
function firstNodeText(values: unknown[]): string {
  for (const entry of values) {
    const text = nodeText(entry);
    if (text) return text;
  }
  return '';
}

/**
 * Text of a parsed element object: CDATA/text parts, else its string leaves.
 *
 * @param value - The element's properties.
 * @returns Its text.
 */
function elementNodeText(value: Record<string, unknown>): string {
  const cdata = nodeText(value['#cdata']);
  const text = nodeText(value['#text']);
  if (cdata || text) return `${cdata}${text}`.trim();
  const parts: string[] = [];
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
 * @param value - The stop-node's parsed value.
 * @returns Its raw inner markup.
 */
export function htmlPayload(value: unknown): string {
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
 * @param html - The markup.
 * @returns Its text.
 */
export function plainText(html: string): string {
  return stripHtmlTags(decodeHtmlEntities(decodeHtmlEntities(html)))
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve an Atom link set: prefer `rel="alternate"`, then any link with an
 * `href`, then a link carried as element text (RSS-style).
 *
 * @param value - The entry's `<link>` node(s).
 * @param feedHost - The publisher's own host, for {@link permalinkFor}.
 * @returns The resolved URL, or `''`.
 */
export function atomLink(value: unknown, feedHost: string = ''): string {
  const withHref = records(value).filter((l) => l['@_href']);
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
 * @param links - The entry's `<link>` elements that carry an href.
 * @param href - The chosen `alternate` href.
 * @param feedHost - The publisher's own host, from the feed element.
 * @returns The permalink to store as the document's URL.
 */
function permalinkFor(links: Record<string, unknown>[], href: string, feedHost: string): string {
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
 * @param url - The URL to read.
 * @returns Its host, `www.` stripped.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * An author node's name: `<author><name>…</name></author>` or bare text.
 *
 * @param value - The `<author>` node(s).
 * @returns A display name, or `''`.
 */
export function authorName(value: unknown): string {
  for (const author of asArray(value)) {
    const node = record(author);
    const name = nodeText(node?.name === undefined ? author : node.name);
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
 * @param url - The enclosure's URL.
 * @param type - Its declared MIME type, with any parameters.
 * @param length - Its declared byte count.
 * @returns The normalized enclosure.
 */
export function enclosureOf(url: string, type: unknown, length: unknown): FeedEnclosure {
  const bytes = Math.trunc(Number(length ?? ''));
  const enclosure: FeedEnclosure = {
    url,
    type: (String(type ?? '').split(';', 1)[0] ?? '').trim().toLowerCase(),
  };
  if (Number.isFinite(bytes) && bytes > 0) enclosure.length = bytes;
  return enclosure;
}
