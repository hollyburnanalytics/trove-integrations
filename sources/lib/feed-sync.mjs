import { parse as parseHtmlDocument } from 'node-html-parser';
import {
  decodeHtmlEntities,
  fetchPage,
  htmlToText,
  parseRSS,
  safeDate,
  stableId,
} from './feeds.mjs';
import { advanceDateWatermark, readDateWatermark } from './watermark.mjs';

/** MIME types a page's `<link rel="alternate">` uses to advertise its feed. */
const FEED_LINK_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
]);

/**
 * Find the feed a web page advertises. Users paste site URLs where feed URLs
 * belong ("https://example.com" instead of "https://example.com/feed"); when
 * the fetched document turns out to be an HTML page, its
 * `<link rel="alternate" type="application/rss+xml">` (or atom/json variants)
 * points at the real feed.
 *
 * @param {string} html - The fetched document body.
 * @param {string} baseUrl - The page URL, for resolving relative hrefs.
 * @returns {string | undefined} The advertised feed URL, if any.
 */
export function discoverFeedUrl(html, baseUrl) {
  const root = parseHtmlDocument(html);
  for (const link of root.querySelectorAll('link[rel="alternate"]')) {
    const type = (link.getAttribute('type') || '').toLowerCase().split(';')[0].trim();
    const href = link.getAttribute('href');
    if (!href || !FEED_LINK_TYPES.has(type)) continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      // Malformed href — keep scanning; a later link may be valid.
    }
  }
}

/**
 * Build a TroveDocument from a parsed feed item, the standard way every
 * multi-feed source adapter wants it: stable ID, entity-decoded title, body as
 * plain text, and a safe date.
 *
 * By default the body is the item's `description` (the feed excerpt/summary) —
 * headline source adapters (BBC/FT/Guardian/NYT) intentionally store only the
 * publisher-provided summary. Pass `fullText: true` to store the fullest body
 * the feed provides (`bodyHtml`: `content:encoded` / Atom `content`, falling
 * back to the raw description markup) — what a subscribed-blog source like
 * `rss-feeds` wants.
 *
 * @param {string} idPrefix - stable-ID namespace (e.g. `'bbc'`)
 * @param {object} item - a `parseRSS()` item, plus a resolved `url`
 * @param {object} [options]
 * @param {string} [options.defaultAuthor] - author when the item has none
 * @param {string[]} [options.tags] - tags to attach (omitted when empty)
 * @param {boolean} [options.fullText] - store the fullest available body
 *   instead of the excerpt
 * @returns {object} TroveDocument
 */
export function feedItemDocument(idPrefix, item, { defaultAuthor, tags, fullText = false } = {}) {
  const date = safeDate(item.pubDate);
  const body = fullText ? item.bodyHtml || item.description : item.description;
  const document = {
    id: stableId(idPrefix, item.guid || item.link),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    text: [decodeHtmlEntities(item.title || ''), htmlToText(body || '')]
      .filter(Boolean)
      .join('\n\n'),
    url: item.url || item.link,
    author: item.author || defaultAuthor,
    date: date || new Date().toISOString(),
  };
  if (tags && tags.length > 0) document.tags = tags;
  return document;
}

/**
 * Fetch one feed URL and parse its items. When the URL turns out to be an HTML
 * page rather than a feed (users paste site URLs), follow the feed the page
 * advertises instead of failing.
 */
async function fetchFeedItems(context, feed, parseFeed) {
  const body = await fetchPage(feed.url);
  try {
    return parseFeed(body);
  } catch (parseError) {
    const discovered = discoverFeedUrl(body, feed.url);
    if (!discovered || discovered === feed.url) throw parseError;
    context.log.info(`  ${feed.label || feed.url}: HTML page — using its feed ${discovered}`);
    return parseFeed(await fetchPage(discovered));
  }
}

/**
 * Process one feed's items into documents: dedupe by URL against `seenUrls`
 * (shared across feeds) and drop items at or before the date watermark.
 *
 * @returns {{ documents: object[], dates: number[], skipped: number }}
 */
function collectFeedItems(items, { feed, seenUrls, lastDate, toDocument }) {
  const documents = [];
  const dates = [];
  let skipped = 0;

  for (const item of items) {
    const url = item.link || item.guid;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const ms = item.pubDate ? new Date(item.pubDate).getTime() : Number.NaN;
    if (lastDate && Number.isFinite(ms) && ms <= lastDate.getTime()) {
      skipped++;
      continue;
    }
    if (Number.isFinite(ms)) dates.push(ms);
    documents.push(toDocument({ ...item, url }, feed));
  }

  return { documents, dates, skipped };
}

/**
 * Generic multi-feed sync. Fetches each feed, dedupes items by URL across all
 * feeds, drops items at or before the `date` watermark, maps survivors to
 * documents, and advances a `date` watermark that is held back whenever any
 * feed failed (so a transient failure never strands the failed feed's older
 * items behind the healthy feeds' high-water mark).
 *
 * Per-feed failures are warned and skipped; if *every* feed fails the whole
 * sync throws (the source is unreachable — a fatal error).
 *
 * @param {object} context - harness context
 * @param {object} options
 * @param {Array<object>} options.feeds - feed descriptors; each needs `url`,
 *   plus any per-feed metadata the `toDocument` callback wants (e.g. `section`)
 * @param {(item: object, feed: object) => object} options.toDocument - build a
 *   TroveDocument from a parsed item (with resolved `url`) and its feed
 * @param {(xml: string) => object[]} [options.parseFeed] - parser; defaults to
 *   `parseRSS`. Items must expose `link`/`guid` and `pubDate`.
 * @param {string} [options.label] - noun for log/progress lines (e.g. `'sections'`)
 * @param {string} [options.emptyWarning] - when `feeds` is empty, warn with this
 *   and return an empty result instead of running (for configurable source adapters)
 * @returns {Promise<{documents: object[], cursor: object|undefined, stats: object}>}
 */
export async function syncFeeds(
  context,
  { feeds, toDocument, parseFeed = parseRSS, label = 'feeds', emptyWarning },
) {
  if (!feeds || feeds.length === 0) {
    if (emptyWarning) context.log.warn(emptyWarning);
    return { documents: [], cursor: undefined, stats: { fetched: 0 } };
  }

  const lastDate = readDateWatermark(context.cursor);
  context.log.info(`Fetching ${feeds.length} ${label}...`);

  const documents = [];
  const seenUrls = new Set();
  const dates = [];
  let skipped = 0;
  let failures = 0;

  for (const [index, feed] of feeds.entries()) {
    try {
      const items = await fetchFeedItems(context, feed, parseFeed);
      const collected = collectFeedItems(items, { feed, seenUrls, lastDate, toDocument });
      documents.push(...collected.documents);
      dates.push(...collected.dates);
      skipped += collected.skipped;
      context.log.info(`  ${feed.label || feed.url}: ${documents.length} so far`);
    } catch (error) {
      failures++;
      context.log.warn(`  ${feed.label || feed.url}: failed — ${error.message}`);
    }

    context.progress(
      documents.length,
      `${documents.length} items from ${index + 1}/${feeds.length} ${label}`,
    );
  }

  if (failures === feeds.length) {
    throw new Error(`All ${feeds.length} ${label} failed to fetch`);
  }

  const maxIso = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : undefined;
  const cursor = advanceDateWatermark({
    previous: context.cursor,
    maxIso,
    anyFailed: failures > 0,
  });

  const seenNote = skipped > 0 ? ` (${skipped} already seen)` : '';
  context.log.info(`Collected ${documents.length} items${seenNote}`);

  return { documents, cursor, stats: { fetched: documents.length, skipped } };
}
