import {
  decodeHtmlEntities,
  fetchPage,
  htmlToText,
  parseRSS,
  safeDate,
  stableId,
} from './feeds.mjs';
import { advanceDateWatermark, readDateWatermark } from './watermark.mjs';

/**
 * Build a TroveDocument from a parsed feed item, the standard way every
 * multi-feed connector wants it: stable ID, entity-decoded title, body as
 * plain text, and a safe date.
 *
 * Uses the item's `description` (the feed excerpt/summary) as the body — NOT
 * `content:encoded`. Headline connectors (BBC/FT/Guardian/NYT) intentionally
 * store only the publisher-provided summary; full-text blog feeds use
 * `syncRSS()` instead, which does prefer the full body.
 *
 * @param {string} idPrefix - stable-ID namespace (e.g. `'bbc'`)
 * @param {object} item - a `parseRSS()` item, plus a resolved `url`
 * @param {object} [options]
 * @param {string} [options.defaultAuthor] - author when the item has none
 * @param {string[]} [options.tags] - tags to attach (omitted when empty)
 * @returns {object} TroveDocument
 */
export function feedItemDocument(idPrefix, item, { defaultAuthor, tags } = {}) {
  const date = safeDate(item.pubDate);
  const document = {
    id: stableId(idPrefix, item.guid || item.link),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    text: [decodeHtmlEntities(item.title || ''), htmlToText(item.description || '')]
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
 *   and return an empty result instead of running (for configurable connectors)
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
      const items = parseFeed(await fetchPage(feed.url));
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
