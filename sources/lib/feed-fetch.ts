/**
 * Gathering entries from a source's feeds: fetch them `concurrency` at a time,
 * parse each body, and fold the results into one ordered accumulator.
 *
 * This is the half of a feed sync that talks to the network and keeps count.
 * {@link module:feed-sync} owns the other half — what a document looks like,
 * which entries survive a per-run cap, and what the round returns. They split
 * when the combined file outgrew the per-file line limit, along the seam they
 * already had: everything here is about *reaching* feeds, nothing here decides
 * what is emitted.
 *
 * Concurrency is a correctness concern, not a nicety: the harness grants a soft
 * deadline and the runner kills an overrunning source outright, losing its
 * documents AND its cursor. Feeds past that deadline are left `unreached`
 * rather than fetched, which the caller must treat as a hold — their older
 * items would otherwise be stranded behind the cursor the fetched feeds
 * advanced.
 *
 * @module
 */

import { parse as parseHtmlDocument } from 'node-html-parser';
import { feedRelocation, feedSelfTitle } from './feed-identity.ts';
import {
  fetchPage,
  fetchPageWithMeta,
  hasDeadlinePassed,
  isTooLargeError,
  itemIdentity,
  warnIfUndated,
} from './feeds.ts';
import type { Document, Feed, FeedEntry, FeedItem, FeedOutcome, SourceContext } from './types.js';

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
 * @param html - The fetched document body.
 * @param baseUrl - The page URL, for resolving relative hrefs.
 * @returns The advertised feed URL, if any.
 */
export function discoverFeedUrl(html: string, baseUrl: string): string | undefined {
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
 * Build a document from one parsed feed item and the feed it came from, or
 * return `undefined` to reject an item the source cannot represent.
 *
 * Every entry point that walks a feed takes one of these, so it is named once
 * rather than respelled at each call site.
 */
export type ToDocument = (item: FeedItem, feed: Feed) => Document | undefined;

/** The accumulator {@link collectFeedItems} folds one feed's items into. */
export interface CollectState {
  /** The feed these items came from. */
  feed: Feed;
  /** Identities already emitted, across all feeds. */
  seenIdentities: Set<string>;
  /** The date cursor; items at or before it are skipped. */
  lastDate?: Date;
  toDocument: ToDocument;
}

/** The accumulator {@link absorbFeedItems} appends to. */
export interface AbsorbState {
  /** Where collected entries go. */
  entries: FeedEntry[];
  /** Identities already emitted. */
  seenIdentities: Set<string>;
  /** The date cursor. */
  lastDate?: Date;
  toDocument: ToDocument;
}

/**
 * Everything {@link absorbBatch} folds one concurrent batch into, plus what it
 * needs to say where in the run the batch sits.
 */
export interface BatchState extends AbsorbState {
  /** Titles the feeds gave themselves. */
  feedTitles: string[];
  /** 301 targets the feeds reported. */
  relocations: string[];
  /** How many feeds this source has, for progress lines. */
  total: number;
  /** This batch's offset into the feed list. */
  start: number;
  /** The noun for log lines (e.g. "sections"). */
  label: string;
}

/** What {@link fetchAllFeeds} fetches, and how hard it may push. */
export interface FetchAllOptions {
  /** The feeds to fetch, in order. */
  feeds: Feed[];
  /** The noun for log lines. */
  label: string;
  /** The parser to run over each body. */
  parseFeed: (xml: string) => FeedItem[];
  /** The date cursor. */
  lastDate?: Date;
  toDocument: ToDocument;
  /** Per-feed response-size cap. */
  maxBytes?: number;
  /** How many feeds to fetch at once. */
  concurrency: number;
}

/**
 * Fetch one feed URL and parse its items. When the URL turns out to be an HTML
 * page rather than a feed (users paste site URLs), follow the feed the page
 * advertises instead of failing.
 *
 * @param context - The harness context.
 * @param feed - The feed to fetch.
 * @param parseFeed - The parser to run over the body.
 * @param maxBytes - Per-response size cap.
 * @returns Its items.
 */
export async function fetchFeedItems(
  context: SourceContext,
  feed: Feed,
  parseFeed: (xml: string) => FeedItem[],
  maxBytes?: number,
): Promise<{ items: FeedItem[]; movedPermanentlyTo?: string }> {
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
 * @param items - The feed's parsed items.
 * @param options - The shared accumulator state.
 * @returns Its entries.
 */
export function collectFeedItems(
  items: FeedItem[],
  { feed, seenIdentities, lastDate, toDocument }: CollectState,
): { entries: FeedEntry[]; skipped: number } {
  const entries: Array<{ document: Document; ms: number }> = [];
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
 * Warn about one feed's fetch failure, naming it and why it failed.
 *
 * @param context - The harness context.
 * @param outcome - The failed outcome.
 */
export function warnFetchFailure(context: SourceContext, outcome: FeedOutcome & { error: Error }) {
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
 * @param context - The harness context.
 * @param outcome - The successful outcome.
 * @param state - The shared accumulator.
 * @returns How many items this feed's cursor skipped.
 */
export function absorbFeedItems(
  context: SourceContext,
  outcome: FeedOutcome & { items: FeedItem[] },
  { entries, seenIdentities, lastDate, toDocument }: AbsorbState,
): number {
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
 * @param context - The harness context.
 * @param outcomes - One batch's fetch outcomes, in feed order.
 * @param state - The shared accumulators.
 * @returns Deltas.
 */
export function absorbBatch(
  context: SourceContext,
  outcomes: FeedOutcome[],
  state: BatchState,
): { skipped: number; transient: number; permanent: number } {
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
 * @param context - The harness context.
 * @param options - What to fetch and how.
 * @returns
 *   Everything collected, plus the counters that decide whether the cursor holds.
 */
export async function fetchAllFeeds(
  context: SourceContext,
  { feeds, label, parseFeed, lastDate, toDocument, maxBytes, concurrency }: FetchAllOptions,
): Promise<{
  entries: FeedEntry[];
  feedTitles: string[];
  relocations: string[];
  skipped: number;
  transient: number;
  permanent: number;
  unreached: number;
}> {
  const entries: FeedEntry[] = [];
  const feedTitles: string[] = [];
  const relocations: string[] = [];
  const seenIdentities: Set<string> = new Set();
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
