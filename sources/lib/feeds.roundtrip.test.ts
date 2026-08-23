import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stableId, syncRSS } from './feeds.ts';
import { at, fetchMock, makeSourceContext, setFetch } from './test-fixtures.ts';
import type { Cursor, SourceContext, SourceSyncResult } from './types.js';

// Multi-run / cursor round-trip tests.
//
// The per-call cursor logic is covered by feeds.test.mjs. These tests
// run a source adapter *multiple times in sequence*, feeding the cursor produced by
// one run into the next, to pin down the cross-run incremental contract:
//   - a second run over an unchanged source returns nothing new,
//   - only items past the cursor are returned next run, and the cursor advances,
//   - a transient failure leaves its item out of the cursor so it resumes,
//   - and the documented edge cases (boundary equality, dateless items, and the
//     no-cursor baseline that relies on server externalId dedup).

// --- fetch harness (a URL -> response map; { fail: true } yields an HTTP 500) ---

/**
 * A response streaming `content` once.
 *
 * @param content - The body.
 * @returns The response, as far as `fetchPage` reads it.
 */
function streamBody(content: string): unknown {
  const encoded = new TextEncoder().encode(content);
  return {
    ok: true,
    headers: new Headers(),
    body: {
      getReader: () => {
        let isDone = false;
        return {
          read: () => {
            if (isDone) return Promise.resolve({ done: true, value: undefined });
            isDone = true;
            return Promise.resolve({ done: false, value: encoded });
          },
        };
      },
    },
  };
}

/**
 * Sorted document ids for a sync result — used to compare runs order-independently.
 */
const documentIds: (result: SourceSyncResult) => string[] = (result) =>
  result.documents.map((d) => d.id).toSorted();

/**
 * Route fetch by URL. Values are response bodies (strings) or `{ fail: true }`.
 *
 * @param map - URL → body or failure.
 * @returns Nothing; it installs the implementation.
 */
function respond(map: Record<string, string | { fail: true }>): void {
  fetchMock().mockImplementation((url) => {
    const entry = map[String(url)];
    if (entry === undefined) return Promise.resolve({ ok: false, status: 404 });
    if (typeof entry === 'object') return Promise.resolve({ ok: false, status: 500 });
    return Promise.resolve(streamBody(entry));
  });
}

/**
 * A context, optionally resuming from `cursor`.
 *
 * @param cursor - The previous run's cursor.
 * @returns The context.
 */
const makeContext = (cursor?: Cursor): SourceContext => makeSourceContext({ cursor });

beforeEach(() => {
  setFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- RSS feeds ---

const FEED_URL = 'https://example.com/feed';
const RSS_OPTS = { feedUrl: FEED_URL, idPrefix: 'blog', defaultAuthor: 'Author' };

/**
 * Build an RSS feed.
 *
 * @param items - Its items.
 * @returns The document.
 */
function rssFeed(items: Array<{ title: string; guid: string; date?: string }>): string {
  const body = items
    .map(
      (item) =>
        `<item><title>${item.title}</title>` +
        `<link>https://example.com/${item.guid}</link>` +
        (item.date ? `<pubDate>${item.date}</pubDate>` : '') +
        `<guid>${item.guid}</guid></item>`,
    )
    .join('');
  return `<rss><channel>${body}</channel></rss>`;
}

const A = { title: 'A', guid: 'a', date: 'Mon, 01 Jan 2024 00:00:00 GMT' };
const B = { title: 'B', guid: 'b', date: 'Wed, 10 Jan 2024 00:00:00 GMT' };
const C = { title: 'C', guid: 'c', date: 'Mon, 15 Jan 2024 00:00:00 GMT' };
const ND = { title: 'ND', guid: 'nd' }; // no date

describe('RSS incremental round-trips', () => {
  it('second run over an unchanged feed returns nothing new and preserves the cursor', async () => {
    respond({ [FEED_URL]: rssFeed([A, B]) });

    const run1 = await syncRSS(makeContext(), RSS_OPTS);
    expect(run1.documents.map((d) => d.title)).toEqual(['A', 'B']);
    expect(run1.cursor).toEqual({ type: 'date', value: '2024-01-10T00:00:00.000Z' }); // max returned date

    const run2 = await syncRSS(makeContext(run1.cursor), RSS_OPTS);
    expect(run2.documents).toHaveLength(0);
    expect(run2.stats?.skipped).toBe(2);
    expect(run2.cursor).toEqual(run1.cursor); // cursor unchanged
  });

  it('returns only items newer than the cursor on the next run, advancing the cursor', async () => {
    respond({ [FEED_URL]: rssFeed([A, B]) });
    const run1 = await syncRSS(makeContext(), RSS_OPTS);

    // A new post appears; re-run from the prior cursor.
    respond({ [FEED_URL]: rssFeed([A, B, C]) });
    const run2 = await syncRSS(makeContext(run1.cursor), RSS_OPTS);

    expect(run2.documents.map((d) => d.title)).toEqual(['C']);
    expect(run2.cursor).toEqual({ type: 'date', value: '2024-01-15T00:00:00.000Z' });
  });

  it('boundary: an item published exactly at the cursor is treated as already-seen', async () => {
    // The filter is strict greater-than (d > lastDate), so an item at the exact
    // cursor timestamp is NOT re-emitted (it was ingested on the prior run).
    respond({ [FEED_URL]: rssFeed([B]) });

    const result = await syncRSS(
      makeContext({ type: 'date', value: '2024-01-10T00:00:00.000Z' }),
      RSS_OPTS,
    );
    expect(result.documents).toHaveLength(0);
  });

  it('re-emits dateless items every run with a stable id (server dedup is the safety net)', async () => {
    // Items with no publish date can't be compared to the cursor, so they are
    // conservatively re-emitted on every run. They carry a stable id, so the
    // server (INSERT OR IGNORE on externalId) no-ops the duplicate.
    respond({ [FEED_URL]: rssFeed([ND, B]) });

    const run1 = await syncRSS(makeContext(), RSS_OPTS);
    const ndId = run1.documents.find((d) => d.title === 'ND')?.id;
    expect(ndId).toBe(stableId('blog', 'nd'));

    const run2 = await syncRSS(makeContext(run1.cursor), RSS_OPTS);
    expect(run2.documents.map((d) => d.title)).toEqual(['ND']); // dated B filtered out
    expect(at(run2.documents, 0).id).toBe(ndId); // identical id across runs
  });

  it('without a cursor, every run re-emits all items with identical ids', async () => {
    respond({ [FEED_URL]: rssFeed([A, B]) });

    const run1 = await syncRSS(makeContext(), RSS_OPTS);
    const run2 = await syncRSS(makeContext(), RSS_OPTS); // cursor never threaded

    expect(documentIds(run2)).toEqual(documentIds(run1)); // stable ids => server dedup absorbs re-ingest
  });
});
