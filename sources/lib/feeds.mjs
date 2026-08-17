/**
 * The shared-helper entry point for feed source adapters. The complete
 * `syncRSS()` / `syncFeedArticles()` syncs and the single-article fetch live
 * here; the lower-level primitives they build on are re-exported from their
 * focused modules (`http.mjs`, `rss-parse.mjs`, `text.mjs`) so adapters keep
 * importing everything from one place. Feed bodies are stored as plain text
 * (decoded, tags stripped) — we deliberately do not try to reconstruct rich
 * Markdown.
 */

import { parse } from 'node-html-parser';
import { fetchPage } from './http.mjs';
import { parseRSS } from './rss-parse.mjs';
import { decodeHtmlEntities, htmlToText, safeDate, stableId } from './text.mjs';
import { dateWatermark, readDateWatermark } from './watermark.mjs';

// Re-export the feed primitives so `feeds.mjs` stays the single import surface
// for adapters, even though the implementations live in focused sibling modules.
export { fetchPage, fetchPageWithMeta, isTooLargeError } from './http.mjs';
export { parseRSS, xmlText } from './rss-parse.mjs';
export { dayToLocalNoonIso, decodeHtmlEntities, htmlToText, safeDate, stableId } from './text.mjs';

/**
 * Pause between paced requests. Exported so source tests can stub the pacing.
 *
 * @param {number} ms - How long to wait.
 * @returns {Promise<void>} Resolves when the wait is over.
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the host-provided soft deadline has passed. The host sets
 * `context.deadline` to an absolute epoch-ms timestamp a safe margin before it
 * hard-kills the run; paged source adapters check it so a large first run splits
 * across runs (fetch what fits, advance the cursor, resume next run). An absent
 * deadline means "unbounded".
 *
 * @param {import('./types.d.ts').SyncContext} context - The harness context.
 * @returns {boolean} True once the soft budget is spent.
 */
export function hasDeadlinePassed(context) {
  return typeof context.deadline === 'number' && Date.now() >= context.deadline;
}

/**
 * A document's `date` is the *publication* date, and we only ever set it from
 * something the upstream source actually told us. When a source gives us no
 * usable date we leave `date` off entirely rather than substituting the sync
 * time: the server already records its own ingestion date, so a stamped-at-sync
 * date adds no information and actively lies about when the item was published
 * (it would sort a decade-old post as brand new). Undated documents are counted
 * and logged instead, so a feed that silently stops emitting dates is visible.
 *
 * @param {import('./types.d.ts').TroveDocument[]} documents - The documents a source is about to return.
 * @returns {{ undated?: number }} `stats` fragment; empty when all are dated.
 */
export function undatedStats(documents) {
  const undated = documents.filter((document) => !document.date).length;
  return undated > 0 ? { undated } : {};
}

/**
 * Warn when any of `documents` carries no publication date, naming the origin
 * so the operator can tell *which* feed regressed. No-op when all are dated.
 *
 * @param {import('./types.d.ts').SyncContext} context - Harness context (for `log.warn`).
 * @param {import('./types.d.ts').TroveDocument[]} documents - The documents a source is about to return.
 * @param {string} origin - Feed/endpoint URL or label the documents came from.
 */
export function warnIfUndated(context, documents, origin) {
  const { undated } = undatedStats(documents);
  if (undated) {
    context.log.warn(`${undated}/${documents.length} items from ${origin} have no publish date`);
  }
}

/**
 * How many of these entries carry no usable publication date.
 *
 * @param {Array<{document: import('./types.d.ts').TroveDocument, ms: number}>} entries - The entries to count.
 * @returns {number} How many are undated.
 */
export function countUndated(entries) {
  return entries.filter((entry) => !Number.isFinite(entry.ms)).length;
}

/**
 * The string a feed item's stable ID is derived from, or `''` when the item
 * carries no identity at all.
 *
 * `parseRSS()` normalizes every absent field to `''`, so an item with no guid,
 * no link and no title would hash the empty string — and *every* such item in
 * the feed would collapse onto that one document ID, silently overwriting each
 * other. Callers drop these instead (see {@link identifiedItems}).
 *
 * The parameter is the three fields this actually reads, not a whole
 * {@link import('./types.d.ts').FeedItem}: identity is a property of those
 * three, and saying so is what lets a caller ask about an item it is holding
 * only part of.
 *
 * @param {Partial<Pick<import('./types.d.ts').FeedItem, 'guid' | 'link' | 'title'>>} item -
 *   A parsed feed item, or the parts of one that carry identity.
 * @returns {string} Its identity string, or `''`.
 */
export function itemIdentity(item) {
  return withoutFragment(item.guid || item.link || item.title || '');
}

/**
 * Drop a URL's `#fragment`, which is a position inside a document and never
 * part of what the document IS.
 *
 * BBC's guids are the reason. They look like
 * `https://www.bbc.co.uk/news/articles/czjlwlkw1m4o#4`, where the number is the
 * item's index IN THAT FEED — so one article is `#0` in top_stories and `#4` in
 * uk, and its number changes again every time the running order shifts. Keeping
 * the fragment made identity churn: the same article was stored once per
 * section it appeared in, and stored AGAIN whenever it moved. 233 duplicates
 * had accumulated in one library from this alone, and it does not converge —
 * every re-ordering mints another copy.
 *
 * Applied only to things that parse as URLs, so a guid that is an opaque string
 * containing `#` keeps every character of it.
 *
 * @param {string} value - A guid, link or title.
 * @returns {string} The value with any URL fragment removed.
 */
function withoutFragment(value) {
  if (!/^https?:\/\//i.test(value)) return value;
  const hash = value.indexOf('#');
  return hash === -1 ? value : value.slice(0, hash);
}

/**
 * Drop feed items that carry no stable identity, warning once with the count.
 * An item with no guid, link *or* title is unaddressable — we cannot give it an
 * ID that survives the next sync, and keeping it would collide with every other
 * identity-less item in the feed.
 *
 * @param {import('./types.d.ts').SyncContext} context - Harness context (for `log.warn`).
 * @param {import('./types.d.ts').FeedItem[]} items - Parsed feed items.
 * @param {string} origin - Feed URL or label, for the warning.
 * @returns {import('./types.d.ts').FeedItem[]} The items that can be given a stable ID.
 */
function identifiedItems(context, items, origin) {
  const identified = items.filter((item) => itemIdentity(item) !== '');
  const dropped = items.length - identified.length;
  if (dropped > 0) {
    context.log.warn(`Skipped ${dropped} items from ${origin} with no guid, link or title`);
  }
  return identified;
}

/**
 * Fetch and parse an RSS/Atom feed, returning TroveDocuments.
 * Supports incremental sync via a `date` watermark — only returns items
 * published after the cursor date. Cursor advances to max date of returned items.
 *
 * @param {import('./types.d.ts').SyncContext} context - The harness context.
 * @param {object} options - Which feed, and how to label its documents.
 * @param {string} options.feedUrl - The feed to fetch.
 * @param {string} options.idPrefix - The stable-ID namespace.
 * @param {string} [options.defaultAuthor] - Author for items carrying none.
 * @returns {Promise<import('./types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function syncRSS(context, { feedUrl, idPrefix, defaultAuthor }) {
  context.log.info(`Fetching ${feedUrl}...`);
  const xml = await fetchPage(feedUrl);
  const items = parseRSS(xml);

  const lastDate = readDateWatermark(context.cursor);
  const filtered = lastDate
    ? items.filter((item) => {
        if (!item.pubDate) return true; // include items with no date (conservative)
        const d = new Date(item.pubDate);
        return Number.isNaN(d.getTime()) || d > lastDate;
      })
    : items;

  const skipped = items.length - filtered.length;
  const skippedSuffix = skipped > 0 ? ` (${skipped} already seen)` : '';
  context.log.info(`Found ${items.length} items${skippedSuffix}`);
  context.progress(0, `Processing ${filtered.length} items...`);

  const documents = identifiedItems(context, filtered, feedUrl).map((item) => ({
    id: stableId(idPrefix, itemIdentity(item)),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    // Store the fullest body the feed provides (content:encoded / Atom
    // <content>, falling back to the raw description markup) as plain text.
    text: [
      decodeHtmlEntities(item.title || ''),
      htmlToText(item.bodyHtml || item.description || ''),
    ]
      .filter(Boolean)
      .join('\n\n'),
    url: item.link,
    author: item.author || defaultAuthor,
    // Omitted when the feed gives us no usable date — see `undatedStats()`.
    date: safeDate(item.pubDate),
  }));

  warnIfUndated(context, documents, feedUrl);

  // Cursor = max pubDate of RETURNED items (not all items — avoids jumping past unsynced items)
  const returnedDates = filtered
    .map((index) => (index.pubDate ? new Date(index.pubDate).getTime() : 0))
    .filter((d) => d > 0);
  const maxDate =
    returnedDates.length > 0 ? new Date(Math.max(...returnedDates)).toISOString() : undefined;
  const cursor = maxDate ? dateWatermark(maxDate) : context.cursor || undefined;

  return {
    documents,
    cursor,
    stats: { fetched: documents.length, skipped, ...undatedStats(documents) },
  };
}

/**
 * Fetch one article page and extract its body as plain text. `articleSelector`
 * targets the prose container(s) for the site (e.g. `'article'`), so we keep the
 * article and drop nav/share/footer chrome. Falls back to `<article>`/`<main>`
 * when the selector matches nothing.
 *
 * Only use this for sources whose license permits storing the full text
 * (Creative Commons / public domain) — for all-rights-reserved feeds, store the
 * publisher's syndicated excerpt via `syncRSS()` instead.
 *
 * @param {string} url - The article page.
 * @param {string} [articleSelector] - The prose container(s) to keep.
 * @returns {Promise<string>} The extracted body text.
 */
export async function fetchArticleText(url, articleSelector) {
  const root = parse(await fetchPage(url));
  for (const element of root.querySelectorAll('script, style, noscript')) element.remove();
  const matched = articleSelector ? root.querySelectorAll(articleSelector) : [];
  const containers =
    matched.length > 0
      ? matched
      : [root.querySelector('article') || root.querySelector('main') || root];
  const html = containers
    .map((node) => node.innerHTML)
    .join('\n\n')
    // keep paragraph breaks before tags are stripped
    .replaceAll(/<\/(?:p|h[1-6]|li|blockquote)>/gi, '$&\n\n');
  return htmlToText(html);
}

/**
 * Like `syncRSS()`, but the feed only carries excerpts, so for each new item we
 * fetch the article page and store its full text (via {@link fetchArticleText}).
 * Items are processed oldest-first and the run stops at the host's soft deadline,
 * so a large first run resumes cleanly from the `date` watermark. A per-article
 * fetch failure falls back to the feed's excerpt rather than dropping the item.
 *
 * CC / public-domain sources only — see {@link fetchArticleText}.
 */
/**
 * Fetch one article page and build its document.
 *
 * A failed fetch is NOT a missing document: the item's feed excerpt stands in,
 * so the round still produces something addressable rather than a hole the
 * watermark would then skip past.
 *
 * @param {import('./types.d.ts').SyncContext} context - The harness context.
 * @param {import('./types.d.ts').FeedItem} item - The feed item to expand.
 * @param {object} options - How to label the document.
 * @param {string} options.idPrefix - The stable-ID namespace.
 * @param {string} [options.defaultAuthor] - Author for items carrying none.
 * @param {string} [options.articleSelector] - The container to extract.
 * @returns {Promise<import('./types.d.ts').TroveDocument>} The document, body or excerpt.
 */
async function articleToDocument(context, item, { idPrefix, defaultAuthor, articleSelector }) {
  let body;
  try {
    body = await fetchArticleText(item.link, articleSelector);
  } catch (error) {
    context.log.warn(
      `Failed to fetch ${item.link}: ${error instanceof Error ? error.message : String(error)}`,
    );
    body = item.description || ''; // fall back to the feed excerpt
  }
  return {
    id: stableId(idPrefix, itemIdentity(item)),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    text: [decodeHtmlEntities(item.title || ''), body].filter(Boolean).join('\n\n'),
    url: item.link,
    author: item.author || defaultAuthor,
    date: safeDate(item.pubDate),
  };
}

/**
 * Fetch a feed, then fetch each new article's full text, oldest first.
 *
 * For CC / public-domain feeds that carry only excerpts. Deadline-bounded: a
 * large backlog drains across runs, resuming from the `date` watermark.
 *
 * @param {import('./types.d.ts').SyncContext} context - The harness context.
 * @param {object} options - Which feed, and how to label its documents.
 * @param {string} options.feedUrl - The feed to fetch.
 * @param {string} options.idPrefix - The stable-ID namespace.
 * @param {string} [options.defaultAuthor] - Author for items carrying none.
 * @param {string} [options.articleSelector] - The prose container to extract.
 * @param {number} [options.delayMs] - Pause between article fetches.
 * @returns {Promise<import('./types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function syncFeedArticles(
  context,
  { feedUrl, idPrefix, defaultAuthor, articleSelector, delayMs = 300 },
) {
  context.log.info(`Fetching ${feedUrl}...`);
  const items = parseRSS(await fetchPage(feedUrl));
  const lastDate = readDateWatermark(context.cursor);

  const fresh = identifiedItems(context, items, feedUrl)
    .filter((item) => {
      if (!lastDate || !item.pubDate) return true;
      const d = new Date(item.pubDate);
      return Number.isNaN(d.getTime()) || d > lastDate;
    })
    .toSorted((a, b) => new Date(a.pubDate || 0).getTime() - new Date(b.pubDate || 0).getTime());

  /** @type {import('./types.d.ts').TroveDocument[]} */
  const documents = [];
  /** @type {number[]} */
  const dates = [];
  let isStoppedEarly = false;
  for (const [index, item] of fresh.entries()) {
    if (hasDeadlinePassed(context)) {
      context.log.info('Time budget reached — resuming next run');
      isStoppedEarly = true;
      break;
    }
    documents.push(
      await articleToDocument(context, item, { idPrefix, defaultAuthor, articleSelector }),
    );
    const t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
    if (t > 0) dates.push(t);
    context.progress(documents.length, `${documents.length} articles`);
    if (delayMs && index < fresh.length - 1) await sleep(delayMs);
  }

  warnIfUndated(context, documents, feedUrl);

  const maxIso = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : undefined;
  const cursor = maxIso ? dateWatermark(maxIso) : context.cursor || undefined;
  return {
    documents,
    cursor,
    stats: {
      fetched: documents.length,
      remaining: isStoppedEarly ? fresh.length - documents.length : 0,
      ...undatedStats(documents),
    },
  };
}
