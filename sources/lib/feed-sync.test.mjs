import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverFeedUrl } from './feed-fetch.ts';
import { feedItemDocument, syncFeeds } from './feed-sync.ts';
import {
  at,
  dateCursorValue,
  fetchMock,
  makeFeedItem,
  makeSourceContext,
  okResponse as ok,
  setFetch,
} from './test-fixtures.ts';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * A context, optionally resuming from `cursor`.
 *
 * @param {import('./types.d.ts').Cursor} [cursor] - The previous run's cursor.
 * @param {Record<string, import('./types.d.ts').ConfigValue>} [config] - Source config.
 * @returns {import('./types.d.ts').SourceContext} The context.
 */
const makeContext = (cursor, config = {}, overrides = {}) =>
  makeSourceContext({ config, cursor, ...overrides });

/**
 * One RSS `<item>`.
 *
 * @param {object} fields - What the item carries.
 * @param {string} fields.title - Its `<title>`.
 * @param {string} fields.link - Its `<link>`.
 * @param {string} [fields.description] - Its `<description>`.
 * @param {string} [fields.date] - Its `<pubDate>`.
 * @returns {string} The element.
 */
function rssItem({ title, link, description = 'Body', date = 'Mon, 15 Jan 2024 10:00:00 GMT' }) {
  return `<item><title>${title}</title><link>${link}</link>
    <description>${description}</description><pubDate>${date}</pubDate></item>`;
}

/**
 * An RSS document wrapping `items`.
 *
 * @param {...string} items - The rendered `<item>` elements.
 * @returns {string} The document.
 */
function rss(...items) {
  return `<rss><channel>${items.join('')}</channel></rss>`;
}

/**
 * The plain `toDocument` most of these tests use.
 *
 * @param {string} [idPrefix] - The stable-id namespace.
 * @param {string} [author] - The default author.
 * @returns {(item: import('./types.d.ts').FeedItem) => import('./types.d.ts').Document}
 *   A mapper.
 */
const STD =
  (idPrefix = 'x', author = 'Default') =>
  (item) =>
    feedItemDocument(idPrefix, item, { defaultAuthor: author });

/**
 * An item with its own guid but the show's shared homepage as `<link>`.
 *
 * @param {string} title - Its `<title>`.
 * @param {string} guid - Its `<guid>`.
 * @returns {string} The element.
 */
function sharedLinkItem(title, guid) {
  return `<item><title>${title}</title><link>https://show.test</link>
    <guid isPermaLink="false">${guid}</guid>
    <pubDate>Mon, 15 Jan 2024 10:00:00 GMT</pubDate></item>`;
}

/**
 * A response whose declared Content-Length blows the cap.
 *
 * @param {number} bytes - The length to declare.
 * @returns {Response} The response, as far as `fetchPage` reads it.
 */
function huge(bytes) {
  return /** @type {Response} */ (
    /** @type {unknown} */ ({
      ok: true,
      headers: new Headers({ 'content-length': String(bytes) }),
      body: undefined,
    })
  );
}

/**
 * `count` feed descriptors, whose URLs end in their index.
 *
 * @param {number} count - How many.
 * @returns {import('./types.d.ts').Feed[]} The descriptors.
 */
function feedsFor(count) {
  return Array.from({ length: count }, (_, index) => ({ url: `https://s.test/${index}` }));
}

/**
 * Respond to `/<i>` with a single item titled "Ep <i>".
 *
 * @returns {void} Nothing; it installs the implementation.
 */
function respondPerFeed() {
  fetchMock().mockImplementation((url) => {
    const index = String(url).split('/').pop();
    return Promise.resolve(
      ok(rss(rssItem({ title: `Ep ${index}`, link: `https://a.test/${index}` }))),
    );
  });
}

describe('feedItemDocument', () => {
  it('builds a stable, normalized document', () => {
    const document = feedItemDocument(
      'bbc',
      makeFeedItem({
        title: 'Hello &amp; Goodbye',
        link: 'https://x.test/a',
        url: 'https://x.test/a',
        description: '<p>Summary</p>',
        pubDate: 'Mon, 15 Jan 2024 10:00:00 GMT',
        guid: 'https://x.test/a',
      }),
    );
    expect(document.id).toMatch(/^bbc-/);
    expect(document.title).toBe('Hello & Goodbye');
    expect(document.text).toContain('Summary');
    expect(document.url).toBe('https://x.test/a');
    expect(document.date).toBe('2024-01-15T10:00:00.000Z');
  });

  it('leaves date unset when the item carries no usable pubDate', () => {
    const base = makeFeedItem({ title: 'A', link: 'https://x.test/a', guid: 'https://x.test/a' });
    expect(feedItemDocument('p', base).date).toBeUndefined();
    expect(feedItemDocument('p', { ...base, pubDate: 'whenever' }).date).toBeUndefined();
  });

  it('produces the same id for the same item (stability)', () => {
    const item = makeFeedItem({ title: 'A', link: 'https://x.test/a', guid: 'https://x.test/a' });
    expect(feedItemDocument('p', item).id).toBe(feedItemDocument('p', item).id);
  });

  it('falls back to the default author and omits empty tags', () => {
    const document = feedItemDocument('p', makeFeedItem({ title: 'A', link: 'l' }), {
      defaultAuthor: 'Acme',
      tags: [],
    });
    expect(document.author).toBe('Acme');
    expect(document).not.toHaveProperty('tags');
  });

  it('keeps the item author and attaches non-empty tags', () => {
    const document = feedItemDocument(
      'p',
      makeFeedItem({ title: 'A', link: 'l', author: 'Jane' }),
      { defaultAuthor: 'Acme', tags: ['news'] },
    );
    expect(document.author).toBe('Jane');
    expect(document.tags).toEqual(['news']);
  });
});

describe('syncFeeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('warns and returns empty when no feeds and an emptyWarning is set', async () => {
    const context = makeContext();
    const result = await syncFeeds(context, {
      feeds: [],
      toDocument: STD(),
      emptyWarning: 'nothing configured',
    });
    expect(context.log.warn).toHaveBeenCalledWith('nothing configured');
    expect(result).toEqual({ documents: [], cursor: undefined, stats: { fetched: 0 } });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('fetches every feed and maps items to documents', async () => {
    fetchMock()
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))))
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'B', link: 'https://s.test/b' }))));

    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(result.documents.map((d) => d.title)).toEqual(['A', 'B']);
    expect(result.stats?.fetched).toBe(2);
  });

  it('dedupes the same URL across feeds', async () => {
    fetchMock().mockResolvedValue(ok(rss(rssItem({ title: 'Same', link: 'https://s.test/dup' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    expect(result.documents).toHaveLength(1);
  });

  it('skips items at or before the date cursor', async () => {
    fetchMock().mockResolvedValue(
      ok(
        rss(
          rssItem({
            title: 'Old',
            link: 'https://s.test/old',
            date: 'Mon, 01 Jan 2020 00:00:00 GMT',
          }),
        ),
      ),
    );
    const result = await syncFeeds(
      makeContext({ type: 'date', value: '2024-01-01T00:00:00.000Z' }),
      {
        feeds: [{ url: 'https://s.test/1' }],
        toDocument: STD('s'),
      },
    );
    expect(result.documents).toHaveLength(0);
    expect(result.stats?.skipped).toBe(1);
  });

  it('advances the cursor to the newest item date', async () => {
    fetchMock().mockResolvedValue(
      ok(
        rss(
          rssItem({
            title: 'New',
            link: 'https://s.test/new',
            date: 'Wed, 10 Jan 2024 00:00:00 GMT',
          }),
        ),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    expect(result.cursor).toEqual({ type: 'date', value: '2024-01-10T00:00:00.000Z' });
  });

  it('holds the previous cursor when a feed fails', async () => {
    fetchMock()
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'Ok', link: 'https://s.test/ok' }))))
      .mockRejectedValueOnce(new Error('boom'));
    /** @type {import('./types.d.ts').Cursor} */
    const previous = { type: 'date', value: '2020-01-01T00:00:00.000Z' };
    const context = makeContext(previous);
    const result = await syncFeeds(context, {
      feeds: [
        { url: 'https://s.test/1', label: 'one' },
        { url: 'https://s.test/2', label: 'two' },
      ],
      toDocument: STD('s'),
    });
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('two: failed'));
    expect(result.documents).toHaveLength(1);
    expect(result.cursor).toBe(previous);
  });

  it('throws when every feed fails', async () => {
    fetchMock().mockRejectedValue(new Error('down'));
    await expect(
      syncFeeds(makeContext(), { feeds: [{ url: 'https://s.test/1' }], toDocument: STD('s') }),
    ).rejects.toThrow(/All 1 feeds failed/);
  });

  it('passes per-feed metadata to toDocument', async () => {
    fetchMock().mockResolvedValue(ok(rss(rssItem({ title: 'Tagged', link: 'https://s.test/t' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1', label: 'world' }],
      toDocument: (item, feed) => feedItemDocument('s', item, { tags: [feed.label ?? ''] }),
    });
    expect(at(result.documents, 0).tags).toEqual(['world']);
  });

  it('reports progress for each feed', async () => {
    fetchMock().mockResolvedValue(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))));
    const context = makeContext();
    await syncFeeds(context, {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
      label: 'sections',
    });
    expect(context.progress).toHaveBeenCalledTimes(2);
  });
});

describe('feedItemDocument fullText', () => {
  it('stores the fullest body when fullText is set, excerpt otherwise', () => {
    const item = makeFeedItem({
      title: 'Post',
      link: 'https://x.test/p',
      description: 'Excerpt only',
      bodyHtml: '<p>The whole post, with paragraphs.</p><p>More.</p>',
      pubDate: 'Mon, 15 Jan 2024 10:00:00 GMT',
    });
    const excerpt = feedItemDocument('rss', item);
    expect(excerpt.text).toContain('Excerpt only');
    expect(excerpt.text).not.toContain('whole post');

    const full = feedItemDocument('rss', item, { fullText: true });
    expect(full.text).toContain('The whole post, with paragraphs.');
    expect(full.text).toContain('More.');
  });

  it('falls back to the description when the feed ships no body', () => {
    const document = feedItemDocument(
      'rss',
      makeFeedItem({
        title: 'T',
        link: 'https://x.test/t',
        description: 'Only this',
        bodyHtml: '',
      }),
      { fullText: true },
    );
    expect(document.text).toContain('Only this');
  });
});

describe('discoverFeedUrl', () => {
  it('finds the advertised feed and resolves relative hrefs', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/style.css"/>
      <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/"/>
    </head><body></body></html>`;
    expect(discoverFeedUrl(html, 'https://seths.blog/post/x')).toBe('https://seths.blog/feed/');
  });

  it('returns undefined when the page advertises no feed', () => {
    expect(discoverFeedUrl('<html><head></head></html>', 'https://x.test/')).toBeUndefined();
  });
});

describe('syncFeeds feed autodiscovery', () => {
  beforeEach(() => {
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('follows a pasted site URL to its advertised feed', async () => {
    const page = `<html><head><link rel="alternate" type="application/atom+xml" href="https://blog.test/atom.xml"/></head><body>hi</body></html>`;
    const feed = rss(rssItem({ title: 'Found', link: 'https://blog.test/found' }));
    fetchMock().mockImplementation((url) =>
      Promise.resolve(ok(String(url).includes('atom.xml') ? feed : page)),
    );

    const context = makeContext();
    const result = await syncFeeds(context, {
      feeds: [{ url: 'https://blog.test/' }],
      toDocument: STD(),
    });
    expect(result.documents).toHaveLength(1);
    expect(at(result.documents, 0).title).toBe('Found');
  });

  it('fails the feed loudly when the page advertises no feed', async () => {
    fetchMock().mockImplementation(() => Promise.resolve(ok('<html><body>nope</body></html>')));
    const context = makeContext();
    await expect(
      syncFeeds(context, { feeds: [{ url: 'https://blog.test/' }], toDocument: STD() }),
    ).rejects.toThrow(/failed to fetch/);
  });
});

describe('syncFeeds item rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('counts an item as skipped when toDocument returns undefined', async () => {
    fetchMock().mockResolvedValue(
      ok(
        rss(
          rssItem({ title: 'Keep', link: 'https://s.test/keep' }),
          rssItem({ title: 'Drop', link: 'https://s.test/drop' }),
        ),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: (item) => (item.title === 'Drop' ? undefined : STD('s')(item)),
    });
    expect(result.documents.map((d) => d.title)).toEqual(['Keep']);
    expect(result.stats?.skipped).toBe(1);
  });

  it('does not advance the cursor on behalf of a rejected item', async () => {
    fetchMock().mockResolvedValue(
      ok(
        rss(
          rssItem({
            title: 'Kept',
            link: 'https://s.test/a',
            date: 'Tue, 02 Jan 2024 00:00:00 GMT',
          }),
          rssItem({
            title: 'Rejected',
            link: 'https://s.test/b',
            date: 'Wed, 31 Dec 2025 00:00:00 GMT',
          }),
        ),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: (item) => (item.title === 'Rejected' ? undefined : STD('s')(item)),
    });
    expect(dateCursorValue(result.cursor)).toBe('2024-01-02T00:00:00.000Z');
  });
});

describe('syncFeeds maxDocuments and firstRunLookbackMs', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  /** `count` items dated one day apart, newest first — the order real feeds use. */
  /**
   * @param {number} count - How many items.
   * @returns {string} The document.
   */
  function feedOf(count) {
    const items = Array.from({ length: count }, (_, index) =>
      rssItem({
        title: `E${index}`,
        link: `https://s.test/${index}`,
        date: new Date(Date.now() - index * DAY_MS).toUTCString(),
      }),
    );
    return rss(...items);
  }

  it('emits the oldest slice first and holds the rest back', async () => {
    fetchMock().mockResolvedValue(ok(feedOf(5)));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
      maxDocuments: 2,
    });
    expect(result.documents.map((d) => d.title)).toEqual(['E4', 'E3']);
    expect(result.stats ?? {}).toMatchObject({ fetched: 2, remaining: 3 });
  });

  it('advances the cursor only to the newest EMITTED item', async () => {
    fetchMock().mockResolvedValue(ok(feedOf(5)));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
      maxDocuments: 2,
    });
    // E3, not E0: the held-back items must not be stranded behind the cursor.
    const expected = new Date(String(at(result.documents, 1).date)).toISOString();
    expect(dateCursorValue(result.cursor)).toBe(expected);
  });

  it('drains the backlog across runs without losing an item', async () => {
    fetchMock().mockResolvedValue(ok(feedOf(5)));
    const seen = [];
    let cursor;
    for (let run = 0; run < 3; run++) {
      const result = await syncFeeds(makeContext(cursor), {
        feeds: [{ url: 'https://s.test/1' }],
        toDocument: STD('s'),
        maxDocuments: 2,
      });
      seen.push(...result.documents.map((d) => d.title));
      cursor = result.cursor;
    }
    expect(seen).toEqual(['E4', 'E3', 'E2', 'E1', 'E0']);
  });

  it('reports no remaining and preserves feed order when under the cap', async () => {
    fetchMock().mockResolvedValue(ok(feedOf(3)));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
      maxDocuments: 25,
    });
    expect(result.documents.map((d) => d.title)).toEqual(['E0', 'E1', 'E2']);
    expect(result.stats?.remaining).toBe(0);
  });

  it('omits remaining entirely when no cap is configured', async () => {
    fetchMock().mockResolvedValue(ok(feedOf(3)));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    expect(result.stats ?? {}).toEqual({ fetched: 3, skipped: 0 });
  });

  it('ignores items older than the first-run lookback', async () => {
    fetchMock().mockResolvedValue(
      ok(
        rss(
          rssItem({ title: 'Recent', link: 'https://s.test/new', date: new Date().toUTCString() }),
          rssItem({
            title: 'Archive',
            link: 'https://s.test/old',
            date: new Date(Date.now() - 400 * DAY_MS).toUTCString(),
          }),
        ),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
      firstRunLookbackMs: 14 * DAY_MS,
    });
    expect(result.documents.map((d) => d.title)).toEqual(['Recent']);
    expect(result.stats?.skipped).toBe(1);
  });

  it('lets an existing cursor override the lookback', async () => {
    fetchMock().mockResolvedValue(
      ok(
        rss(
          rssItem({
            title: 'Older than lookback, newer than cursor',
            link: 'https://s.test/mid',
            date: new Date(Date.now() - 100 * DAY_MS).toUTCString(),
          }),
        ),
      ),
    );
    /** @type {import('./types.d.ts').Cursor} */
    const cursor = { type: 'date', value: new Date(Date.now() - 200 * DAY_MS).toISOString() };
    const result = await syncFeeds(makeContext(cursor), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
      firstRunLookbackMs: 14 * DAY_MS,
    });
    expect(result.documents).toHaveLength(1);
  });
});

describe('syncFeeds dedupe keys on identity, not link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('keeps every episode when a feed points them all at one page', async () => {
    // The Freakonomics/Hard Fork shape: one <link> for all 924 episodes. Keying
    // dedupe on the link collapsed 923 of them onto the first.
    fetchMock().mockResolvedValue(
      ok(
        rss(
          sharedLinkItem('Ep 1', 'g-1'),
          sharedLinkItem('Ep 2', 'g-2'),
          sharedLinkItem('Ep 3', 'g-3'),
        ),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    expect(result.documents.map((d) => d.title)).toEqual(['Ep 1', 'Ep 2', 'Ep 3']);
    expect(new Set(result.documents.map((d) => d.id)).size).toBe(3);
  });

  it('still dedupes the same guid across two feeds', async () => {
    fetchMock().mockResolvedValue(ok(rss(sharedLinkItem('Same', 'g-1'))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    expect(result.documents).toHaveLength(1);
  });
});

describe('syncFeeds oversized-feed handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('raises the cap when feedMaxBytes is set', async () => {
    // Declares 12 MB — over fetchPage's 10 MB default, under the raised cap.
    const response = ok(rss(rssItem({ title: 'Big', link: 'https://s.test/big' })), {
      contentLength: 12 * 1024 * 1024,
    });
    fetchMock().mockResolvedValue(response);
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
      feedMaxBytes: 32 * 1024 * 1024,
    });
    expect(result.documents).toHaveLength(1);
  });

  it('does not hold the cursor hostage to a permanently oversized feed', async () => {
    // Feed 1 is too big to ever fetch; feed 2 is healthy. The cursor must still
    // advance, or feed 2's backlog can never drain.
    const healthy = ok(
      rss(
        rssItem({
          title: 'Fine',
          link: 'https://s.test/ok',
          date: 'Wed, 10 Jan 2024 00:00:00 GMT',
        }),
      ),
    );
    fetchMock().mockImplementation((url) =>
      Promise.resolve(String(url).includes('/big') ? huge(999 * 1024 * 1024) : healthy),
    );
    const context = makeContext();
    const result = await syncFeeds(context, {
      feeds: [{ url: 'https://s.test/big' }, { url: 'https://s.test/ok' }],
      toDocument: STD('s'),
    });
    expect(dateCursorValue(result.cursor)).toBe('2024-01-10T00:00:00.000Z');
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('skipping permanently'));
  });

  it('still holds the cursor for a transient failure', async () => {
    const healthy = ok(
      rss(
        rssItem({
          title: 'Fine',
          link: 'https://s.test/ok',
          date: 'Wed, 10 Jan 2024 00:00:00 GMT',
        }),
      ),
    );
    fetchMock().mockImplementation((url) =>
      String(url).includes('/flaky')
        ? Promise.reject(new Error('socket hang up'))
        : Promise.resolve(healthy),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/flaky' }, { url: 'https://s.test/ok' }],
      toDocument: STD('s'),
    });
    expect(result.cursor).toBeUndefined();
  });

  it('still throws when every feed fails, oversized included', async () => {
    fetchMock().mockResolvedValue(huge(999 * 1024 * 1024));
    await expect(
      syncFeeds(makeContext(), { feeds: [{ url: 'https://s.test/big' }], toDocument: STD('s') }),
    ).rejects.toThrow(/failed to fetch/);
  });
});

describe('syncFeeds concurrency and the soft deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('collects in feed order even when responses land out of order', async () => {
    // Feed 0 resolves last; document order must still follow the feed list, or
    // which feed wins a shared identity would vary run to run.
    fetchMock().mockImplementation((url) => {
      const index = Number(String(url).split('/').pop());
      const body = rss(rssItem({ title: `Ep ${index}`, link: `https://a.test/${index}` }));
      return new Promise((resolve) => setTimeout(() => resolve(ok(body)), index === 0 ? 30 : 1));
    });
    const result = await syncFeeds(makeContext(), {
      feeds: feedsFor(4),
      toDocument: STD('s'),
      concurrency: 4,
    });
    expect(result.documents.map((d) => d.title)).toEqual(['Ep 0', 'Ep 1', 'Ep 2', 'Ep 3']);
  });

  it('fetches concurrently rather than one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock().mockImplementation((url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const index = String(url).split('/').pop();
      const body = rss(rssItem({ title: `Ep ${index}`, link: `https://a.test/${index}` }));
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve(ok(body));
        }, 5),
      );
    });
    await syncFeeds(makeContext(), { feeds: feedsFor(10), toDocument: STD('s'), concurrency: 5 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('defaults to sequential so existing sources are unchanged', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock().mockImplementation((url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const index = String(url).split('/').pop();
      const body = rss(rssItem({ title: `Ep ${index}`, link: `https://a.test/${index}` }));
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve(ok(body));
        }, 2),
      );
    });
    await syncFeeds(makeContext(), { feeds: feedsFor(4), toDocument: STD('s') });
    expect(peak).toBe(1);
  });

  it('stops at the soft deadline instead of overrunning the run', async () => {
    respondPerFeed();
    // `deadline` is readonly on SourceContext — a source is handed a budget,
    // it does not set one. Build the past deadline instead of assigning it.
    const context = makeContext(undefined, {}, { deadline: Date.now() - 1 });
    const result = await syncFeeds(context, { feeds: feedsFor(10), toDocument: STD('s') });
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('Soft deadline reached'));
  });

  it('holds the cursor when feeds went unreached, so they are not skipped later', async () => {
    // Deadline trips after the first batch: feeds 2..3 were never fetched and
    // may carry items older than what feed 0-1 advanced the cursor to.
    fetchMock().mockImplementation((url) => {
      const index = String(url).split('/').pop();
      const body = rss(rssItem({ title: `Ep ${index}`, link: `https://a.test/${index}` }));
      return new Promise((resolve) => setTimeout(() => resolve(ok(body)), 30));
    });
    // Enough budget for the first batch, spent by the time the second is due.
    const context = makeContext(undefined, {}, { deadline: Date.now() + 20 });
    const result = await syncFeeds(context, {
      feeds: feedsFor(4),
      toDocument: STD('s'),
      concurrency: 2,
    });
    expect(result.documents).toHaveLength(2);
    expect(result.cursor).toBeUndefined();
  });

  it('ignores the deadline when the harness supplies none', async () => {
    respondPerFeed();
    const result = await syncFeeds(makeContext(), { feeds: feedsFor(3), toDocument: STD('s') });
    expect(result.documents).toHaveLength(3);
  });
});

/**
 * A channel with a title, so the feed can say what it calls itself.
 *
 * @param {string} title - The channel's `<title>`.
 * @param {...string} items - The rendered `<item>` elements.
 * @returns {string} The document.
 */
function titledRss(title, ...items) {
  return `<rss><channel><title>${title}</title>${items.join('')}</channel></rss>`;
}

describe('syncFeeds reports what the feed calls itself (trove docs/39 D10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('reports the channel title for a single-feed round', async () => {
    fetchMock().mockResolvedValueOnce(
      ok(titledRss('Accidental Tech Podcast', rssItem({ title: 'A', link: 'https://s.test/a' }))),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    // The subscription row is created named after its URL; this is the only
    // thing that can ever tell it otherwise.
    expect(result.feedName).toBe('Accidental Tech Podcast');
  });

  it('reports NO name when a round covered several feeds', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        ok(titledRss('Show One', rssItem({ title: 'A', link: 'https://s.test/a' }))),
      )
      .mockResolvedValueOnce(
        ok(titledRss('Show Two', rssItem({ title: 'B', link: 'https://s.test/b' }))),
      );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    // Two titles and one round: there is no single row the name belongs to, and
    // guessing would rename one subscription after another's show.
    expect(result.feedName).toBeUndefined();
  });

  it('reports no name when the channel is untitled', async () => {
    fetchMock().mockResolvedValueOnce(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    expect(result.feedName).toBeUndefined();
  });

  it('reports no name for an empty feed, having nothing to read it from', async () => {
    fetchMock().mockResolvedValueOnce(ok(titledRss('Silent Show')));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    expect(result.documents).toHaveLength(0);
    expect(result.feedName).toBeUndefined();
  });

  it('keeps reporting the title once the feed has nothing new', async () => {
    // The rename path depends on this: a settled feed emits no documents every
    // round, and if the name only rode along with documents a show could never
    // be renamed after its first sync.
    fetchMock().mockResolvedValueOnce(
      ok(titledRss('Renamed Show', rssItem({ title: 'A', link: 'https://s.test/a' }))),
    );
    const result = await syncFeeds(
      makeContext({ type: 'date', value: '2099-01-01T00:00:00.000Z' }),
      {
        feeds: [{ url: 'https://s.test/1' }],
        toDocument: STD('s'),
      },
    );
    expect(result.documents).toHaveLength(0);
    expect(result.feedName).toBe('Renamed Show');
  });
});

/**
 * A channel advertising a permanent move, the way Apple's spec defines it.
 *
 * @param {string} newUrl - The `<itunes:new-feed-url>` value.
 * @param {...string} items - The rendered `<item>` elements.
 * @returns {string} The document.
 */
function movedRss(newUrl, ...items) {
  return `<rss><channel><title>A Show</title>
    <itunes:new-feed-url>${newUrl}</itunes:new-feed-url>${items.join('')}</channel></rss>`;
}

describe('syncFeeds follows a feed that says it has moved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('reports the new address a single feed advertises', async () => {
    fetchMock().mockResolvedValueOnce(
      ok(movedRss('https://new.test/feed.xml', rssItem({ title: 'A', link: 'https://s.test/a' }))),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://old.test/feed.xml' }],
      toDocument: STD('s'),
    });
    expect(result.feedUrl).toBe('https://new.test/feed.xml');
  });

  it('reports nothing when the feed advertises the address we already fetched', async () => {
    // Publishing your own current URL is common and correct — it is not a move,
    // and reporting it would churn a relocation every single round.
    const url = 'https://same.test/feed.xml';
    fetchMock().mockResolvedValueOnce(
      ok(movedRss(url, rssItem({ title: 'A', link: 'https://s.test/a' }))),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url }],
      toDocument: STD('s'),
    });
    expect(result.feedUrl).toBeUndefined();
  });

  it('reports nothing for a feed advertising no move at all', async () => {
    fetchMock().mockResolvedValueOnce(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }],
      toDocument: STD('s'),
    });
    expect(result.feedUrl).toBeUndefined();
  });

  it('reports NO move when a round covered several feeds', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        ok(movedRss('https://new-a.test/f', rssItem({ title: 'A', link: 'https://s.test/a' }))),
      )
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'B', link: 'https://s.test/b' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    // Applying it would point one subscription at another show's feed.
    expect(result.feedUrl).toBeUndefined();
  });

  it('keeps reporting the move when the feed has nothing new', async () => {
    // A moved feed is usually a stale feed — the publisher stopped updating it
    // once the move was announced. If the signal only rode along with
    // documents, exactly the feeds that need following would never be followed.
    fetchMock().mockResolvedValueOnce(
      ok(movedRss('https://new.test/feed.xml', rssItem({ title: 'A', link: 'https://s.test/a' }))),
    );
    const result = await syncFeeds(
      makeContext({ type: 'date', value: '2099-01-01T00:00:00.000Z' }),
      { feeds: [{ url: 'https://old.test/feed.xml' }], toDocument: STD('s') },
    );
    expect(result.documents).toHaveLength(0);
    expect(result.feedUrl).toBe('https://new.test/feed.xml');
  });
});

/**
 * A redirect response, as `redirect: 'manual'` surfaces it.
 *
 * @param {number} status - The redirect status.
 * @param {string} location - Where it points.
 * @returns {Response} The response.
 */
function moved(status, location) {
  return new Response(undefined, { status, headers: { location } });
}

describe('syncFeeds treats a permanent redirect as a move', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('reports a 301 target as the feed’s new address', async () => {
    fetchMock().mockImplementation((url) =>
      Promise.resolve(
        String(url) === 'https://old.test/f'
          ? moved(301, 'https://new.test/f')
          : ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://old.test/f' }],
      toDocument: STD('s'),
    });
    expect(result.feedUrl).toBe('https://new.test/f');
  });

  it('ignores a 302, which is routing rather than moving', async () => {
    fetchMock().mockImplementation((url) =>
      Promise.resolve(
        String(url) === 'https://s.test/f'
          ? moved(302, 'https://edge.test/f')
          : ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/f' }],
      toDocument: STD('s'),
    });
    expect(result.feedUrl).toBeUndefined();
  });

  it('prefers the show’s own new-feed-url over the host’s redirect', async () => {
    // The tag is the publisher's statement of where subscribers should end up;
    // a redirect is the platform's. When they disagree, the publisher wins.
    fetchMock().mockImplementation((url) =>
      Promise.resolve(
        String(url) === 'https://old.test/f'
          ? moved(301, 'https://host-says.test/f')
          : ok(
              movedRss(
                'https://show-says.test/f',
                rssItem({ title: 'A', link: 'https://s.test/a' }),
              ),
            ),
      ),
    );
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://old.test/f' }],
      toDocument: STD('s'),
    });
    expect(result.feedUrl).toBe('https://show-says.test/f');
  });

  it('reports no move when a redirect only reaches a discovered feed', async () => {
    // Following a site URL to the feed it advertises is not the SUBSCRIPTION
    // relocating; reporting it would move the row onto the homepage chain.
    fetchMock().mockImplementation((url) => {
      const s = String(url);
      if (s === 'https://site.test') {
        return Promise.resolve(moved(301, 'https://site.test/home'));
      }
      if (s === 'https://site.test/home') {
        return Promise.resolve(
          ok('<html><link rel="alternate" type="application/rss+xml" href="/feed.xml"></html>'),
        );
      }
      return Promise.resolve(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))));
    });
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://site.test' }],
      toDocument: STD('s'),
    });
    expect(result.documents).toHaveLength(1);
    expect(result.feedUrl).toBeUndefined();
  });
});
