import type { HTMLElement } from 'node-html-parser';
import { parse as parseHtmlDocument } from 'node-html-parser';
import { parseRSS } from '../rss-parse.ts';
import { decodeHtmlEntities } from '../text.ts';
import type { DirectoryContext, DirectoryEntry, DirectoryQuery } from '../types.js';

/**
 * The RSS directory — resolve mode (trove docs/39 D8).
 *
 * Podcasts have an index to search; the open web does not. What it has instead
 * is the convention that a page advertises its own feeds, so the useful
 * question is not "what is this called?" but **"you gave me an address — what
 * can I actually subscribe to here?"**
 *
 * That is the whole reason `resolve` exists as a mode beside `search`. People
 * paste `https://example.com`, not `https://example.com/feed.xml`, and until
 * now that only worked by accident: the sync would fetch the page, fail to
 * parse it, and quietly look for a feed link. Doing it at configure time means
 * the person SEES what they subscribed to, and picks when a site offers several.
 *
 * This provider declares no auth. It fetches an address the user supplied, so
 * the seam's guarded fetch is doing real work here rather than ceremony.
 *
 * @module
 */

/** MIME types a page's `<link rel="alternate">` uses to advertise a feed. */
const FEED_LINK_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
]);

/** Response-size cap is the seam's; this only bounds how many links we consider. */
const MAX_LINKS = 20;

/**
 * The subscribable address one `<link rel="alternate">` points at, if any.
 *
 * Returns nothing for a non-feed type, an unresolvable href, or a scheme that
 * is not http(s) — the page chose these values, so a `javascript:` or `data:`
 * alternate is untrusted input that must never be offered as a subscription.
 *
 * @param link - A parsed `<link>` element.
 * @param baseUrl - For resolving relative hrefs.
 * @returns The absolute feed URL.
 */
function feedLinkUrl(link: HTMLElement, baseUrl: string): string | undefined {
  const [declared = ''] = (link.getAttribute('type') || '').toLowerCase().split(';', 1);
  const type = declared.trim();
  const href = link.getAttribute('href');
  if (!href || !FEED_LINK_TYPES.has(type)) return;

  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return;
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return;
  return resolved.href;
}

/**
 * The feeds a page advertises, in document order.
 *
 * Returns every alternate rather than the first, because a site with separate
 * post and comment feeds — or one feed per section — is exactly the case where
 * guessing picks wrong and a person picks right.
 *
 * @param html - The fetched document.
 * @param baseUrl - For resolving relative hrefs.
 * @returns Every advertised feed.
 */
export function advertisedFeeds(
  html: string,
  baseUrl: string,
): Array<{ url: string; title: string }> {
  const root = parseHtmlDocument(html);
  const pageTitle = decodeHtmlEntities(root.querySelector('title')?.text?.trim() ?? '');
  const found: Array<{ url: string; title: string }> = [];
  const seen = new Set();

  for (const link of root.querySelectorAll('link[rel="alternate"]')) {
    if (found.length >= MAX_LINKS) break;
    const url = feedLinkUrl(link, baseUrl);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);

    // A site's own label for the feed ("Comments Feed") is what distinguishes
    // several feeds from one another; the page title is the fallback.
    const label = decodeHtmlEntities((link.getAttribute('title') || '').trim());
    found.push({ url, title: label || pageTitle || url });
  }
  return found;
}

/**
 * Resolve an address to the feeds subscribable there.
 *
 * An address that IS a feed resolves to itself, named by its own channel title
 * — so pasting a feed URL confirms what it is rather than rejecting it.
 *
 * @param input - `query` is the pasted address.
 * @param context - The directory context (guarded fetch + log).
 * @returns Subscribable feeds.
 */
export async function query(
  input: DirectoryQuery,
  context: DirectoryContext,
): Promise<DirectoryEntry[]> {
  const address = typeof input.query === 'string' ? input.query.trim() : '';
  // No featured set: "every feed on the web" is not a list, and an empty
  // address is a person who has not typed yet rather than a request.
  if (address === '') return [];

  const response = await context.fetch(address);
  if (!response.ok) {
    throw new Error(`${address} returned ${String(response.status)}`);
  }
  const body = await response.text();

  try {
    const items = parseRSS(body);
    const title = items.find((item) => item.feedTitle)?.feedTitle;
    return [{ value: address, title: (title || address).trim() }];
  } catch {
    // Not a feed — treat it as a page that may advertise some.
    context.log.info(`${address} is not a feed; looking for feeds it advertises`);
  }

  return advertisedFeeds(body, address)
    .slice(0, input.limit)
    .map((feed) => ({ value: feed.url, title: feed.title }));
}
