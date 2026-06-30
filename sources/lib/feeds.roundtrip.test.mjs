import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { stableId, syncRSS } from './feeds.mjs';

// Multi-run / watermark round-trip integration tests.
//
// The per-call cursor logic is covered by feeds.test.mjs. These tests
// run a connector *multiple times in sequence*, feeding the cursor produced by
// one run into the next, to pin down the cross-run incremental contract:
//   - a second run over an unchanged source returns nothing new,
//   - only items past the watermark are returned next run, and the cursor advances,
//   - a transient failure leaves its item out of the cursor so it resumes,
//   - and the documented edge cases (boundary equality, dateless items, and the
//     no-watermark baseline that relies on server externalId dedup).

// --- fetch harness (a URL -> response map; { fail: true } yields an HTTP 500) ---

function streamBody(content) {
  const encoded = new TextEncoder().encode(content);
  return {
    ok: true,
    headers: new Headers(),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () => {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: encoded });
          },
        };
      },
    },
  };
}

/** Sorted document ids for a sync result — used to compare runs order-independently. */
const documentIds = (result) => result.documents.map((d) => d.id).toSorted();

/** Route fetch by URL. Values are response bodies (strings) or `{ fail: true }`. */
function respond(map) {
  fetch.mockImplementation((url) => {
    const entry = map[url];
    if (entry === undefined) return Promise.resolve({ ok: false, status: 404 });
    if (typeof entry === 'object' && entry.fail) return Promise.resolve({ ok: false, status: 500 });
    return Promise.resolve(streamBody(entry));
  });
}

function makeContext(cursor) {
  return { log: { info: mock(), warn: mock() }, progress: mock(), config: {}, cursor };
}

beforeEach(() => {
  globalThis.fetch = mock();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- RSS feeds ---

const FEED_URL = 'https://example.com/feed';
const RSS_OPTS = { feedUrl: FEED_URL, idPrefix: 'blog', defaultAuthor: 'Author' };

/** Build an RSS feed. Each item: { title, guid, date? (RFC822) }. */
function rssFeed(items) {
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
    expect(run2.stats.skipped).toBe(2);
    expect(run2.cursor).toEqual(run1.cursor); // watermark unchanged
  });

  it('returns only items newer than the watermark on the next run, advancing the cursor', async () => {
    respond({ [FEED_URL]: rssFeed([A, B]) });
    const run1 = await syncRSS(makeContext(), RSS_OPTS);

    // A new post appears; re-run from the prior cursor.
    respond({ [FEED_URL]: rssFeed([A, B, C]) });
    const run2 = await syncRSS(makeContext(run1.cursor), RSS_OPTS);

    expect(run2.documents.map((d) => d.title)).toEqual(['C']);
    expect(run2.cursor).toEqual({ type: 'date', value: '2024-01-15T00:00:00.000Z' });
  });

  it('boundary: an item published exactly at the watermark is treated as already-seen', async () => {
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
    // Items with no publish date can't be compared to the watermark, so they are
    // conservatively re-emitted on every run. They carry a stable id, so the
    // server (INSERT OR IGNORE on externalId) no-ops the duplicate.
    respond({ [FEED_URL]: rssFeed([ND, B]) });

    const run1 = await syncRSS(makeContext(), RSS_OPTS);
    const ndId = run1.documents.find((d) => d.title === 'ND').id;
    expect(ndId).toBe(stableId('blog', 'nd'));

    const run2 = await syncRSS(makeContext(run1.cursor), RSS_OPTS);
    expect(run2.documents.map((d) => d.title)).toEqual(['ND']); // dated B filtered out
    expect(run2.documents[0].id).toBe(ndId); // identical id across runs
  });

  it('without a watermark, every run re-emits all items with identical ids', async () => {
    respond({ [FEED_URL]: rssFeed([A, B]) });

    const run1 = await syncRSS(makeContext(), RSS_OPTS);
    const run2 = await syncRSS(makeContext(), RSS_OPTS); // cursor never threaded

    expect(documentIds(run2)).toEqual(documentIds(run1)); // stable ids => server dedup absorbs re-ingest
  });
});
