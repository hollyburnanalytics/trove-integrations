import { advanceDateCursor, readDateCursor } from '@ontrove/extend/source';
import { fetchAllFeeds, type ToDocument } from './feed-fetch.ts';
import { selfReport } from './feed-identity.ts';
import {
  countUndated,
  decodeHtmlEntities,
  htmlToText,
  itemIdentity,
  parseRSS,
  safeDate,
  stableId,
  undatedStats,
} from './feeds.ts';
import type { Document, Feed, FeedItem, SourceContext, SourceSyncResult } from './types.js';

/** How {@link feedItemDocument} labels a document, and how much of it it stores. */
export interface FeedItemDocumentOptions {
  /** Author when the item has none. */
  defaultAuthor?: string;
  /** Tags to attach (omitted when empty). */
  tags?: string[];
  /**
   * Store the fullest available body (`bodyHtml`) instead of the excerpt.
   * Headline sources want the excerpt; a subscribed-blog source wants this.
   */
  fullText?: boolean;
}

/** The whole policy for one {@link syncFeeds} round. */
export interface SyncFeedsOptions {
  /**
   * Feed descriptors; each needs `url`, plus any per-feed metadata the
   * `toDocument` callback wants (e.g. `section`).
   */
  feeds: Feed[];
  toDocument: ToDocument;
  /** Parser; defaults to `parseRSS`. Items must expose `link`/`guid` and `pubDate`. */
  parseFeed?: (xml: string) => FeedItem[];
  /** Noun for log/progress lines (e.g. `'sections'`). */
  label?: string;
  /**
   * When `feeds` is empty, warn with this and return an empty result instead of
   * running (for configurable source adapters).
   */
  emptyWarning?: string;
  /**
   * Cap on documents emitted per run. For sources where each document costs
   * real downstream work (a podcast episode buys a Whisper transcription), this
   * drains a backlog in polite slices across scheduled runs — see
   * {@link selectEntries}. Uncapped by default.
   */
  maxDocuments?: number;
  /**
   * On the first run only (no cursor yet), ignore items published longer ago
   * than this. Stops a freshly added feed from ingesting its entire back
   * catalogue at once.
   */
  firstRunLookbackMs?: number;
  /**
   * Per-feed response-size cap. Defaults to `fetchPage`'s; raise it for feed
   * classes that are legitimately larger than an article feed (a podcast feed
   * carries its whole archive).
   */
  feedMaxBytes?: number;
  /**
   * How many feeds to fetch at once (default 1, i.e. sequential). Raise it for
   * sources whose feed list is long or whose feeds are large enough that
   * fetching them in sequence risks the harness's soft deadline — see
   * {@link fetchAllFeeds}.
   */
  concurrency?: number;
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
 * @param idPrefix - stable-ID namespace (e.g. `'bbc'`)
 * @param item - a `parseRSS()` item, plus a resolved `url`
 * @param options - How to label the document, and how much of it to store.
 * @returns The document.
 *   `text` is narrowed to always present — it is built here from the title and
 *   body rather than copied — so a caller that post-processes the body (the
 *   Guardian's boilerplate strip) does not have to guard a field this never
 *   omits.
 */
export function feedItemDocument(
  idPrefix: string,
  item: FeedItem,
  { defaultAuthor, tags, fullText = false }: FeedItemDocumentOptions = {},
): Document & { text: string } {
  const body = fullText ? item.bodyHtml || item.description : item.description;
  const document: Document & { text: string } = {
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
 * @param entries - Every collected entry.
 * @param maxDocuments - The per-run cap, if the source declares one.
 * @returns The entries to emit.
 */
function selectEntries(
  entries: Array<{ document: Document; ms: number }>,
  maxDocuments?: number,
): Array<{ document: Document; ms: number }> {
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
 */
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
 * @param context - harness context
 * @param options - which feeds to read, and the policy for reading them.
 * @returns The round's documents, cursor and stats.
 */
export async function syncFeeds(
  context: SourceContext,
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
  }: SyncFeedsOptions,
): Promise<SourceSyncResult> {
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
