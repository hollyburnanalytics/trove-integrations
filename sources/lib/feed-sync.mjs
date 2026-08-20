import { advanceDateCursor, readDateCursor } from '@ontrove/extend/source';
import { parse as parseHtmlDocument } from 'node-html-parser';
import { feedRelocation, feedSelfTitle, selfReport } from './feed-identity.mjs';
import {
  countUndated,
  decodeHtmlEntities,
  fetchPage,
  fetchPageWithMeta,
  hasDeadlinePassed,
  htmlToText,
  isTooLargeError,
  itemIdentity,
  parseRSS,
  safeDate,
  stableId,
  undatedStats,
  warnIfUndated,
} from './feeds.mjs';

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
    const type = ((link.getAttribute('type') || '').toLowerCase().split(';', 1)[0] ?? '').trim();
    const href = link.getAttribute('href');
    if (!href || !FEED_LINK_TYPES.has(type)) continue;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      // Malformed href — keep scanning; a later link may be valid.
    }
  }
}

/**
 * Build a Document from a parsed feed item, the standard way every
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
 * `date` is omitted when the item carries no usable publication date — see
 * {@link undatedStats}.
 *
 * @param {string} idPrefix - stable-ID namespace (e.g. `'bbc'`)
 * @param {import('./types.d.ts').FeedItem} item - a `parseRSS()` item, plus a resolved `url`
 * @param {object} [options]
 * @param {string} [options.defaultAuthor] - author when the item has none
 * @param {string[]} [options.tags] - tags to attach (omitted when empty)
 * @param {boolean} [options.fullText] - store the fullest available body
 *   instead of the excerpt
 * @returns {import('./types.d.ts').Document & { text: string }} The document.
 *   `text` is narrowed to always present — it is built here from the title and
 *   body rather than copied — so a caller that post-processes the body (the
 *   Guardian's boilerplate strip) does not have to guard a field this never
 *   omits.
 */
export function feedItemDocument(idPrefix, item, { defaultAuthor, tags, fullText = false } = {}) {
  const body = fullText ? item.bodyHtml || item.description : item.description;
  /** @type {import('./types.d.ts').Document & { text: string }} */
  const document = {
    // itemIdentity, NOT a second hand-rolled `guid || link`. The dedupe key and
    // the stored id have to be the same string or an item can be judged unseen
    // and then written under an id that already exists — and this copy was
    // already subtly different, having no title fallback.
    id: stableId(idPrefix, itemIdentity(item)),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    text: [decodeHtmlEntities(item.title || ''), htmlToText(body || '')]
      .filter(Boolean)
      .join('\n\n'),
    url: item.url || item.link,
    author: item.author || defaultAuthor,
    date: safeDate(item.pubDate),
  };
  if (tags && tags.length > 0) document.tags = tags;
  return document;
}

/**
 * Fetch one feed URL and parse its items. When the URL turns out to be an HTML
 * page rather than a feed (users paste site URLs), follow the feed the page
 * advertises instead of failing.
 *
 * @param {import('./types.d.ts').SourceContext} context - The harness context.
 * @param {import('./types.d.ts').Feed} feed - The feed to fetch.
 * @param {(xml: string) => import('./types.d.ts').FeedItem[]} parseFeed - The parser to run over the body.
 * @param {number} [maxBytes] - Per-response size cap.
 * @returns {Promise<{items: import('./types.d.ts').FeedItem[], movedPermanentlyTo?: string}>} Its items.
 */
async function fetchFeedItems(context, feed, parseFeed, maxBytes) {
  const { text: body, movedPermanentlyTo } = await fetchPageWithMeta(feed.url, { maxBytes });
  try {
    return { items: parseFeed(body), movedPermanentlyTo };
  } catch (parseError) {
    const discovered = discoverFeedUrl(body, feed.url);
    if (!discovered || discovered === feed.url) throw parseError;
    context.log.info(`  ${feed.label || feed.url}: HTML page — using its feed ${discovered}`);
    // A discovered feed is a different resource, not this one relocating, so
    // the redirect that led here says nothing about where the SUBSCRIPTION
    // lives. Reporting it would move the row onto the site's homepage chain.
    return { items: parseFeed(await fetchPage(discovered, { maxBytes })) };
  }
}

/**
 * Process one feed's items into dated document entries: dedupe by identity
 * against `seenIdentities` (shared across feeds) and drop items at or before the
 * date cursor. `toDocument` may return `undefined` to reject an item it
 * cannot represent (e.g. a podcast entry carrying no audio); rejects count as
 * skipped and contribute no date, so the cursor never advances on their
 * behalf.
 *
 * Dedupe is keyed on {@link itemIdentity} — the SAME value a document's stable
 * ID is derived from — so "already seen" means exactly "would produce the
 * document we already have". Keying on the link instead (as this did) silently
 * destroyed data on the many podcast feeds that point every episode at the show's
 * homepage: Freakonomics publishes `<link>https://freakonomics.com</link>` on all
 * 924 episodes, so 923 of them collapsed onto the first. Items with distinct
 * guids are distinct documents and must both survive.
 *
 * @param {import('./types.d.ts').FeedItem[]} items - The feed's parsed items.
 * @param {object} options - The shared accumulator state.
 * @param {import('./types.d.ts').Feed} options.feed - The feed these items came from.
 * @param {Set<string>} options.seenIdentities - Identities already emitted, across all feeds.
 * @param {Date} [options.lastDate] - The date cursor; items at or before it are skipped.
 * @param {(item: import('./types.d.ts').FeedItem, feed: import('./types.d.ts').Feed) => import('./types.d.ts').Document | undefined} options.toDocument -
 *   Build a document, or return undefined to reject the item.
 * @returns {{ entries: Array<{document: import('./types.d.ts').Document, ms: number}>, skipped: number }} Its entries.
 */
function collectFeedItems(items, { feed, seenIdentities, lastDate, toDocument }) {
  /** @type {Array<{document: import('./types.d.ts').Document, ms: number}>} */
  const entries = [];
  let skipped = 0;

  for (const item of items) {
    // Still the resolved document URL, and still the admission test: an item
    // with neither link nor guid is unaddressable.
    const url = item.link || item.guid;
    const identity = itemIdentity(item);
    if (!url || seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);

    const ms = item.pubDate ? new Date(item.pubDate).getTime() : NaN;
    if (lastDate && Number.isFinite(ms) && ms <= lastDate.getTime()) {
      skipped++;
      continue;
    }
    const document = toDocument({ ...item, url }, feed);
    if (!document) {
      skipped++;
      continue;
    }
    entries.push({ document, ms });
  }

  return { entries, skipped };
}

/**
 * Select the entries to emit this run, honouring an optional per-run cap.
 *
 * Uncapped (the default), every entry is emitted in feed order — the order
 * sources have always produced. Capped, entries are re-ordered OLDEST-FIRST and
 * truncated, which is what makes the cap safe to combine with a date cursor:
 * everything held back is strictly newer than everything emitted, so advancing
 * the cursor to the newest emitted item strands nothing.
 *
 * KNOWN LIMIT — undated entries. They carry no date, so they always survive the
 * cursor filter and the cursor can never record having passed them. If a
 * source carries MORE undated entries than the cap, the same prefix is selected
 * every run and the remainder is unreachable forever. No ordering fixes this:
 * sorting undated first merely moves the starvation onto the dated backlog,
 * which — unlike the undated items — a date cursor *can* resume. So undated
 * sort last (the dated backlog always drains) and {@link syncFeeds} warns by
 * name when any are held back. The real repair is a cursor that can address
 * individual items (`idSet`), not a different sort. Measured against 22 live
 * podcast feeds this is unreached: 0 of 12,213 episodes lacked a date.
 *
 * @param {Array<{document: import('./types.d.ts').Document, ms: number}>} entries - Every collected entry.
 * @param {number} [maxDocuments] - The per-run cap, if the source declares one.
 * @returns {Array<{document: import('./types.d.ts').Document, ms: number}>} The entries to emit.
 */
function selectEntries(entries, maxDocuments) {
  if (!maxDocuments || entries.length <= maxDocuments) return entries;
  const ordered = entries.toSorted((a, b) => {
    if (!Number.isFinite(a.ms)) return Number.isFinite(b.ms) ? 1 : 0;
    if (!Number.isFinite(b.ms)) return -1;
    return a.ms - b.ms;
  });
  return ordered.slice(0, maxDocuments);
}

/**
 * Fetch every feed in turn, accumulating their entries. Per-feed failures are
 * warned and counted rather than thrown: one unreachable feed must not cost the
 * user the other twenty. The caller decides what a given failure count means.
 *
 * Two kinds of failure are counted separately. A `transient` one (timeout,
 * 5xx, connection reset) holds the cursor back, because the feed's older
 * items may still be coming. An oversized response is `permanent`: it will be
 * oversized again next run, and every run after that. Counting it as transient
 * would hold the cursor forever — freezing not just that feed but every OTHER
 * feed in the source, since they share one cursor. So it is warned, skipped,
 * and left out of the hold decision.
 *
 * Feeds are fetched `concurrency` at a time but COLLECTED strictly in feed
 * order, so which feed wins a shared item identity — and therefore the document
 * that item produces — does not depend on which response happened to land
 * first. Concurrency exists because wall-clock is a correctness concern, not a
 * nicety: the harness grants a soft deadline (24s by default) and the runner
 * kills an overrunning source outright, losing its documents AND its cursor. A
 * fetch is almost entirely network wait, so 22 real podcast feeds take 27s in
 * sequence and comfortably under 10s five at a time.
 *
 * Feeds past the soft deadline are left `unreached` rather than fetched, which
 * the caller must treat as a hold: their older items would otherwise be
 * stranded behind the cursor the fetched feeds advanced.
 *
 * @returns {Promise<{entries: Array<{document: object, ms: number}>, skipped: number, transient: number, permanent: number, unreached: number}>}
 */
/**
 * Warn about one feed's fetch failure, naming it and why it failed.
 *
 * @param {import('./types.d.ts').SourceContext} context - The harness context.
 * @param {import('./types.d.ts').FeedOutcome & {error: Error}} outcome - The failed outcome.
 */
function warnFetchFailure(context, outcome) {
  const origin = outcome.feed.label || outcome.feed.url;
  context.log.warn(
    isTooLargeError(outcome.error)
      ? `  ${origin}: too large to fetch — skipping permanently (${outcome.error.message})`
      : `  ${origin}: failed — ${outcome.error.message}`,
  );
}

/**
 * Collect one successfully-fetched feed's items into the shared accumulator.
 *
 * @param {import('./types.d.ts').SourceContext} context - The harness context.
 * @param {import('./types.d.ts').FeedOutcome & {items: import('./types.d.ts').FeedItem[]}} outcome - The successful outcome.
 * @param {object} state - The shared accumulator.
 * @param {import('./types.d.ts').FeedEntry[]} state.entries - Where collected entries go.
 * @param {Set<string>} state.seenIdentities - Identities already emitted.
 * @param {Date} [state.lastDate] - The date cursor.
 * @param {(item: import('./types.d.ts').FeedItem, feed: import('./types.d.ts').Feed) => import('./types.d.ts').Document | undefined} state.toDocument -
 *   Build a document, or reject the item.
 * @returns {number} How many items this feed's cursor skipped.
 */
function absorbFeedItems(context, outcome, { entries, seenIdentities, lastDate, toDocument }) {
  const origin = outcome.feed.label || outcome.feed.url;
  const collected = collectFeedItems(outcome.items, {
    feed: outcome.feed,
    seenIdentities,
    lastDate,
    toDocument,
  });
  warnIfUndated(
    context,
    collected.entries.map((entry) => entry.document),
    origin,
  );
  entries.push(...collected.entries);
  context.log.info(`  ${origin}: ${entries.length} so far`);
  return collected.skipped;
}

/**
 * Fold one concurrent batch's outcomes into the shared accumulators, reporting
 * the counters it moved.
 *
 * Its own function because the batching loop and the per-feed handling are two
 * separate concerns, and nesting them made the whole fetch too tangled to read
 * (or to lint).
 *
 * @param {import('./types.d.ts').SourceContext} context - The harness context.
 * @param {import('./types.d.ts').FeedOutcome[]} outcomes - One batch's fetch outcomes, in feed order.
 * @param {object} state - The shared accumulators.
 * @param {import('./types.d.ts').FeedEntry[]} state.entries - Where collected entries go.
 * @param {string[]} state.feedTitles - Titles the feeds gave themselves.
 * @param {string[]} state.relocations - 301 targets the feeds reported.
 * @param {Set<string>} state.seenIdentities - Identities already emitted.
 * @param {Date} [state.lastDate] - The date cursor.
 * @param {(item: import('./types.d.ts').FeedItem, feed: import('./types.d.ts').Feed) => import('./types.d.ts').Document | undefined} state.toDocument -
 *   Build a document, or reject the item.
 * @param {number} state.total - How many feeds this source has, for progress lines.
 * @param {number} state.start - This batch's offset into the feed list.
 * @param {string} state.label - The noun for log lines (e.g. "sections").
 * @returns {{skipped: number, transient: number, permanent: number}} Deltas.
 */
function absorbBatch(context, outcomes, state) {
  const {
    entries,
    feedTitles,
    relocations,
    seenIdentities,
    lastDate,
    toDocument,
    total,
    start,
    label,
  } = state;
  let skipped = 0;
  let transient = 0;
  let permanent = 0;

  for (const [offset, outcome] of outcomes.entries()) {
    if (outcome.error) {
      if (isTooLargeError(outcome.error)) permanent++;
      else transient++;
      warnFetchFailure(context, outcome);
    } else {
      const title = feedSelfTitle(outcome.items);
      if (title) feedTitles.push(title);
      const moved = feedRelocation(outcome.items, outcome.feed.url, outcome.movedPermanentlyTo);
      if (moved) {
        relocations.push(moved);
        context.log.info(
          `  ${outcome.feed.label || outcome.feed.url}: says it has moved to ${moved}`,
        );
      }
      skipped += absorbFeedItems(context, outcome, {
        entries,
        seenIdentities,
        lastDate,
        toDocument,
      });
    }

    context.progress(
      entries.length,
      `${entries.length} items from ${start + offset + 1}/${total} ${label}`,
    );
  }

  return { skipped, transient, permanent };
}

/**
 * Fetch every feed, `concurrency` at a time, collecting in feed order.
 *
 * @param {import('./types.d.ts').SourceContext} context - The harness context.
 * @param {object} options - What to fetch and how.
 * @param {import('./types.d.ts').Feed[]} options.feeds - The feeds to fetch, in order.
 * @param {string} options.label - The noun for log lines.
 * @param {(xml: string) => import('./types.d.ts').FeedItem[]} options.parseFeed - The parser.
 * @param {Date} [options.lastDate] - The date cursor.
 * @param {(item: import('./types.d.ts').FeedItem, feed: import('./types.d.ts').Feed) => import('./types.d.ts').Document | undefined} options.toDocument -
 *   Build a document, or reject the item.
 * @param {number} [options.maxBytes] - Per-feed response-size cap.
 * @param {number} options.concurrency - How many feeds to fetch at once.
 * @returns {Promise<{entries: import('./types.d.ts').FeedEntry[], feedTitles: string[], relocations: string[], skipped: number, transient: number, permanent: number, unreached: number}>}
 *   Everything collected, plus the counters that decide whether the cursor holds.
 */
async function fetchAllFeeds(
  context,
  { feeds, label, parseFeed, lastDate, toDocument, maxBytes, concurrency },
) {
  /** @type {import('./types.d.ts').FeedEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const feedTitles = [];
  /** @type {string[]} */
  const relocations = [];
  /** @type {Set<string>} */
  const seenIdentities = new Set();
  let skipped = 0;
  let transient = 0;
  let permanent = 0;
  let unreached = 0;

  for (let start = 0; start < feeds.length; start += concurrency) {
    if (hasDeadlinePassed(context)) {
      unreached = feeds.length - start;
      context.log.warn(
        `Soft deadline reached — ${unreached} of ${feeds.length} ${label} not fetched; ` +
          'holding the cursor so they are not skipped next run',
      );
      break;
    }

    const batch = feeds.slice(start, start + concurrency);
    const outcomes = await Promise.all(
      batch.map(async (feed) => {
        try {
          return { feed, ...(await fetchFeedItems(context, feed, parseFeed, maxBytes)) };
        } catch (error) {
          // Normalised because the warning prints `.message`, and a thrown
          // string used to print "failed — undefined".
          return { feed, error: error instanceof Error ? error : new Error(String(error)) };
        }
      }),
    );

    const tally = absorbBatch(context, outcomes, {
      entries,
      feedTitles,
      relocations,
      seenIdentities,
      lastDate,
      toDocument,
      total: feeds.length,
      start,
      label,
    });
    skipped += tally.skipped;
    transient += tally.transient;
    permanent += tally.permanent;
  }

  return { entries, feedTitles, relocations, skipped, transient, permanent, unreached };
}

/**
 * Generic multi-feed sync. Fetches each feed, dedupes items by URL across all
 * feeds, drops items at or before the `date` cursor, maps survivors to
 * documents, and advances a `date` cursor that is held back whenever any
 * feed failed (so a transient failure never strands the failed feed's older
 * items behind the healthy feeds' high-water mark).
 *
 * Per-feed failures are warned and skipped; if *every* feed fails the whole
 * sync throws (the source is unreachable — a fatal error).
 *
 * @param {import('./types.d.ts').SourceContext} context - harness context
 * @param {object} options
 * @param {import('./types.d.ts').Feed[]} options.feeds - feed descriptors; each needs `url`,
 *   plus any per-feed metadata the `toDocument` callback wants (e.g. `section`)
 * @param {(item: import('./types.d.ts').FeedItem, feed: import('./types.d.ts').Feed) => import('./types.d.ts').Document|undefined} options.toDocument -
 *   build a Document from a parsed item (with resolved `url`) and its feed;
 *   return `undefined` to skip an item the source cannot represent
 * @param {(xml: string) => import('./types.d.ts').FeedItem[]} [options.parseFeed] - parser; defaults to
 *   `parseRSS`. Items must expose `link`/`guid` and `pubDate`.
 * @param {string} [options.label] - noun for log/progress lines (e.g. `'sections'`)
 * @param {string} [options.emptyWarning] - when `feeds` is empty, warn with this
 *   and return an empty result instead of running (for configurable source adapters)
 * @param {number} [options.maxDocuments] - cap on documents emitted per run. For
 *   sources where each document costs real downstream work (a podcast episode
 *   buys a Whisper transcription), this drains a backlog in polite slices across
 *   scheduled runs — see {@link selectEntries}. Uncapped by default.
 * @param {number} [options.firstRunLookbackMs] - on the first run only (no
 *   cursor yet), ignore items published longer ago than this. Stops a freshly
 *   added feed from ingesting its entire back catalogue at once.
 * @param {number} [options.feedMaxBytes] - per-feed response-size cap. Defaults
 *   to `fetchPage`'s; raise it for feed classes that are legitimately larger
 *   than an article feed (a podcast feed carries its whole archive).
 * @param {number} [options.concurrency] - how many feeds to fetch at once
 *   (default 1, i.e. sequential). Raise it for sources whose feed list is long
 *   or whose feeds are large enough that fetching them in sequence risks the
 *   harness's soft deadline — see {@link fetchAllFeeds}.
 * @returns {Promise<import('./types.d.ts').SourceSyncResult>} The round's documents, cursor and stats.
 */
export async function syncFeeds(
  context,
  {
    feeds,
    toDocument,
    parseFeed = parseRSS,
    label = 'feeds',
    emptyWarning,
    maxDocuments,
    firstRunLookbackMs,
    feedMaxBytes,
    concurrency = 1,
  },
) {
  if (!feeds || feeds.length === 0) {
    if (emptyWarning) context.log.warn(emptyWarning);
    return { documents: [], cursor: undefined, stats: { fetched: 0 } };
  }

  const lastDate =
    readDateCursor(context.cursor) ??
    (firstRunLookbackMs ? new Date(Date.now() - firstRunLookbackMs) : undefined);
  context.log.info(`Fetching ${feeds.length} ${label}...`);

  const { entries, feedTitles, relocations, skipped, transient, permanent, unreached } =
    await fetchAllFeeds(context, {
      feeds,
      label,
      parseFeed,
      lastDate,
      toDocument,
      maxBytes: feedMaxBytes,
      concurrency,
    });

  if (transient + permanent === feeds.length) {
    throw new Error(`All ${feeds.length} ${label} failed to fetch`);
  }

  const selected = selectEntries(entries, maxDocuments);
  const documents = selected.map((entry) => entry.document);
  const dates = selected.map((entry) => entry.ms).filter((ms) => Number.isFinite(ms));
  const remaining = entries.length - selected.length;

  // Held-back DATED items resume next run via the cursor; held-back UNDATED
  // items cannot be resumed at all — see {@link selectEntries}. Name them, so a
  // feed that stops emitting dates surfaces as a warning instead of as a
  // silently truncated archive.
  const undatedHeld = countUndated(entries) - countUndated(selected);
  if (undatedHeld > 0) {
    context.log.warn(
      `${undatedHeld} undated item(s) exceed the ${maxDocuments}-item cap and a date cursor ` +
        'cannot resume past them — they stay unreachable until the dated backlog clears and the ' +
        `source carries fewer than ${maxDocuments} undated items.`,
    );
  }

  const maxIso = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : undefined;
  const cursor = advanceDateCursor({
    previous: context.cursor,
    maxIso,
    // A transient failure or a feed we never reached holds the cursor — see
    // {@link fetchAllFeeds}. A permanent failure does not.
    anyFailed: transient > 0 || unreached > 0,
  });

  const seenNote = skipped > 0 ? ` (${skipped} already seen)` : '';
  const heldNote = remaining > 0 ? `, ${remaining} held for the next run` : '';
  context.log.info(`Collected ${documents.length} items${seenNote}${heldNote}`);

  return {
    documents,
    cursor,
    // What this subscription says about itself — see feed-identity.mjs for
    // why both facts are single-feed-only.
    ...selfReport({ feedCount: feeds.length, titles: feedTitles, relocations }),
    stats: {
      fetched: documents.length,
      skipped,
      // Only meaningful — and only reported — when a cap is in play, so
      // uncapped sources keep the stats shape they have always returned.
      ...(maxDocuments && { remaining }),
      ...undatedStats(documents),
    },
  };
}
