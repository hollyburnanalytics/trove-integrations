import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { feedItemDocument, syncFeeds } from './feed-sync.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

function makeContext(cursor, config = {}) {
  return { log: { info: mock(), warn: mock() }, progress: mock(), config, cursor };
}

function rssItem({ title, link, description = 'Body', date = 'Mon, 15 Jan 2024 10:00:00 GMT' }) {
  return `<item><title>${title}</title><link>${link}</link>
    <description>${description}</description><pubDate>${date}</pubDate></item>`;
}

function rss(...items) {
  return `<rss><channel>${items.join('')}</channel></rss>`;
}

/** A minimal `fetch` Response that `fetchPage` can stream, carrying `text`. */
function ok(text) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    body: {
      getReader() {
        let done = false;
        return {
          read() {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: bytes });
          },
          cancel() {},
        };
      },
    },
  };
}

const STD =
  (idPrefix = 'x', author = 'Default') =>
  (item) =>
    feedItemDocument(idPrefix, item, { defaultAuthor: author });

describe('feedItemDocument', () => {
  it('builds a stable, normalized document', () => {
    const document = feedItemDocument('bbc', {
      title: 'Hello &amp; Goodbye',
      link: 'https://x.test/a',
      url: 'https://x.test/a',
      description: '<p>Summary</p>',
      pubDate: 'Mon, 15 Jan 2024 10:00:00 GMT',
      guid: 'https://x.test/a',
    });
    expect(document.id).toMatch(/^bbc-/);
    expect(document.title).toBe('Hello & Goodbye');
    expect(document.text).toContain('Summary');
    expect(document.url).toBe('https://x.test/a');
    expect(document.date).toBe('2024-01-15T10:00:00.000Z');
  });

  it('produces the same id for the same item (stability)', () => {
    const item = { title: 'A', link: 'https://x.test/a', guid: 'https://x.test/a' };
    expect(feedItemDocument('p', item).id).toBe(feedItemDocument('p', item).id);
  });

  it('falls back to the default author and omits empty tags', () => {
    const document = feedItemDocument(
      'p',
      { title: 'A', link: 'l' },
      { defaultAuthor: 'Acme', tags: [] },
    );
    expect(document.author).toBe('Acme');
    expect(document).not.toHaveProperty('tags');
  });

  it('keeps the item author and attaches non-empty tags', () => {
    const document = feedItemDocument(
      'p',
      { title: 'A', link: 'l', author: 'Jane' },
      { defaultAuthor: 'Acme', tags: ['news'] },
    );
    expect(document.author).toBe('Jane');
    expect(document.tags).toEqual(['news']);
  });
});

describe('syncFeeds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = mock();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches every feed and maps items to documents', async () => {
    fetch
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))))
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'B', link: 'https://s.test/b' }))));

    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.documents.map((d) => d.title)).toEqual(['A', 'B']);
    expect(result.stats.fetched).toBe(2);
  });

  it('dedupes the same URL across feeds', async () => {
    fetch.mockResolvedValue(ok(rss(rssItem({ title: 'Same', link: 'https://s.test/dup' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
    });
    expect(result.documents).toHaveLength(1);
  });

  it('skips items at or before the date watermark', async () => {
    fetch.mockResolvedValue(
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
    expect(result.stats.skipped).toBe(1);
  });

  it('advances the cursor to the newest item date', async () => {
    fetch.mockResolvedValue(
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
    fetch
      .mockResolvedValueOnce(ok(rss(rssItem({ title: 'Ok', link: 'https://s.test/ok' }))))
      .mockRejectedValueOnce(new Error('boom'));
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
    fetch.mockRejectedValue(new Error('down'));
    await expect(
      syncFeeds(makeContext(), { feeds: [{ url: 'https://s.test/1' }], toDocument: STD('s') }),
    ).rejects.toThrow(/All 1 feeds failed/);
  });

  it('passes per-feed metadata to toDocument', async () => {
    fetch.mockResolvedValue(ok(rss(rssItem({ title: 'Tagged', link: 'https://s.test/t' }))));
    const result = await syncFeeds(makeContext(), {
      feeds: [{ url: 'https://s.test/1', section: 'world' }],
      toDocument: (item, feed) => feedItemDocument('s', item, { tags: [feed.section] }),
    });
    expect(result.documents[0].tags).toEqual(['world']);
  });

  it('reports progress for each feed', async () => {
    fetch.mockResolvedValue(ok(rss(rssItem({ title: 'A', link: 'https://s.test/a' }))));
    const context = makeContext();
    await syncFeeds(context, {
      feeds: [{ url: 'https://s.test/1' }, { url: 'https://s.test/2' }],
      toDocument: STD('s'),
      label: 'sections',
    });
    expect(context.progress).toHaveBeenCalledTimes(2);
  });
});
