import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { validateResult } from '../../lib/harness.mjs';
import { episodeDocument, sync } from './index.mjs';

/**
 * These drive the real `syncFeeds` path with only `fetch` mocked, rather than
 * stubbing the helper: the interesting behavior of this source (the per-run
 * cap, the first-run lookback, which enclosures are accepted) lives in the
 * interaction, and a stubbed helper would assert only that we passed the
 * options we passed. Every result is also run through the harness's real
 * `validateResult`, so a document shape the server would reject fails here.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeContext(config = {}, cursor) {
  return { log: { info: mock(), warn: mock() }, progress: mock(), config, cursor };
}

/** A minimal `fetch` Response that `fetchPage` can stream. */
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

const feed = (items, channelTitle = 'The Test Show') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${channelTitle}</title>${items.join('')}</channel></rss>`;

const NOW_RFC = new Date().toUTCString();

/** One well-formed episode; every field overridable. */
function episode({
  title = 'Episode 12: Something',
  guid = 'tag:show.test,2026:12',
  link = 'https://show.test/12',
  date = NOW_RFC,
  encl = '<enclosure url="https://cdn.test/12.mp3" length="42000000" type="audio/mpeg"/>',
  extra = '',
} = {}) {
  const linkTag = link ? `<link>${link}</link>` : '';
  const guidTag = guid ? `<guid>${guid}</guid>` : '';
  const dateTag = date ? `<pubDate>${date}</pubDate>` : '';
  return `<item><title>${title}</title>${linkTag}${guidTag}${dateTag}${extra}${encl}</item>`;
}

async function run(xml, { config = { feeds: ['https://a.test/rss'] }, cursor, context } = {}) {
  globalThis.fetch = mock(() => Promise.resolve(ok(xml)));
  const base = context ?? makeContext(config, cursor);
  const result = await sync({ ...base, cursor: cursor ?? base.cursor });
  validateResult(result);
  return result;
}

describe('podcast-feeds configuration', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('fetches every configured feed', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok(feed([episode()]))));
    await sync(makeContext({ feeds: ['https://a.test/rss', 'https://b.test/rss'] }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('warns and does nothing when no feeds are configured', async () => {
    const context = makeContext({});
    const result = await sync(context);
    expect(result).toEqual({ documents: [], cursor: undefined, stats: { fetched: 0 } });
    expect(context.log.warn).toHaveBeenCalledWith('No podcast feeds configured');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('caps a run at 25 episodes and holds the rest back', async () => {
    // Spaced 6 hours apart so all 40 sit inside the 14-day first-run window and
    // the cap — not the lookback — is what bounds the run.
    const items = Array.from({ length: 40 }, (_, index) =>
      episode({
        title: `Ep ${index}`,
        guid: `g${index}`,
        link: `https://show.test/${index}`,
        date: new Date(Date.now() - index * (DAY_MS / 4)).toUTCString(),
      }),
    );
    const result = await run(feed(items));
    expect(result.stats.fetched).toBe(25);
    expect(result.stats.remaining).toBe(15);
    // Oldest first, so the watermark can resume without stranding anything.
    expect(result.documents[0].title).toBe('Ep 39');
  });

  it('limits a first run to the recent window instead of the whole archive', async () => {
    const result = await run(
      feed([
        episode({ title: 'Recent', guid: 'g1', link: 'https://show.test/1' }),
        episode({
          title: 'Archive',
          guid: 'g2',
          link: 'https://show.test/2',
          date: new Date(Date.now() - 400 * DAY_MS).toUTCString(),
        }),
      ]),
    );
    expect(result.documents.map((d) => d.title)).toEqual(['Recent']);
    expect(result.stats.skipped).toBe(1);
  });

  it('accepts a feed larger than the default 10 MB page cap', async () => {
    // Real podcast feeds carry the whole archive: The Daily's is 17.6 MB.
    const response = ok(feed([episode()]));
    response.headers = new Headers({ 'content-length': String(17 * 1024 * 1024) });
    globalThis.fetch = mock(() => Promise.resolve(response));
    const result = await sync(makeContext({ feeds: ['https://a.test/rss'] }));
    expect(result.stats.fetched).toBe(1);
  });
});

describe('podcast-feeds against adversarial feeds', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('names an episode that has no title', async () => {
    const result = await run(feed([episode({ title: '' })]));
    expect(result.documents[0].title).toBe('Untitled episode');
  });

  it('skips an enclosure with an empty url attribute', async () => {
    const result = await run(feed([episode({ encl: '<enclosure url="" type="audio/mpeg"/>' })]));
    expect(result.stats.fetched).toBe(0);
  });

  it('keeps two episodes that share a title and link but differ by guid', async () => {
    const shared = { title: 'Same', link: 'https://show.test' };
    const result = await run(
      feed([episode({ ...shared, guid: 'g1' }), episode({ ...shared, guid: 'g2' })]),
    );
    expect(result.stats.fetched).toBe(2);
    expect(new Set(result.documents.map((d) => d.id)).size).toBe(2);
  });

  it('drops a repeated guid within one feed', async () => {
    const result = await run(
      feed([episode({ title: 'First', guid: 'same' }), episode({ title: 'Second', guid: 'same' })]),
    );
    expect(result.stats.fetched).toBe(1);
  });

  it('drops an item carrying no identity of its own rather than colliding', async () => {
    // Neither guid nor link: unaddressable, so there is no id that could
    // survive the next sync. Dropping beats emitting two documents that would
    // hash to the same id and silently overwrite each other.
    const result = await run(
      feed([
        episode({ title: 'Ep one', guid: '', link: '' }),
        episode({ title: 'Ep two', guid: '', link: '' }),
      ]),
    );
    expect(result.documents).toHaveLength(0);
  });

  it('never emits two documents sharing one id', async () => {
    const result = await run(
      feed([
        episode({ title: 'Ep one', guid: 'g1', link: 'https://show.test' }),
        episode({ title: 'Ep two', guid: 'g2', link: 'https://show.test' }),
        episode({ title: 'Ep three', guid: 'g3', link: 'https://show.test' }),
      ]),
    );
    const ids = result.documents.map((d) => d.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('leaves an unparseable date unset rather than inventing one', async () => {
    const result = await run(feed([episode({ date: 'not a date' })]));
    expect(result.documents[0].date).toBeUndefined();
  });

  it('does not let a future-dated episode drag the cursor past now', async () => {
    const future = new Date(Date.now() + 400 * DAY_MS).toUTCString();
    const result = await run(feed([episode({ date: future })]));
    expect(new Date(result.cursor.value).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('emits nothing rather than throwing for a channel with no items', async () => {
    const result = await run(feed([]));
    expect(result.stats.fetched).toBe(0);
  });

  it('fails loudly when the URL is not a feed at all', async () => {
    globalThis.fetch = mock(() => Promise.resolve(ok('<html><body>hi</body></html>')));
    await expect(sync(makeContext({ feeds: ['https://a.test/rss'] }))).rejects.toThrow();
  });

  it('warns by name when undated items exceed the cap and cannot be resumed', async () => {
    // A `date` watermark cannot record progress past an undated item, so an
    // undated backlog larger than the cap stays unreachable however many times
    // we run. This pins that bounded behavior AND the warning that surfaces it,
    // so a feed which stops emitting dates is visible rather than silent.
    const items = Array.from({ length: 30 }, (_, index) =>
      episode({
        title: `Ep ${index}`,
        guid: `g${index}`,
        link: `https://show.test/${index}`,
        date: '',
      }),
    );
    const xml = feed(items);
    const context = makeContext({ feeds: ['https://a.test/rss'] });
    globalThis.fetch = mock(() => Promise.resolve(ok(xml)));

    const seen = new Set();
    let cursor;
    for (let index = 0; index < 5; index++) {
      const result = await sync({ ...context, cursor });
      for (const document of result.documents) seen.add(document.title);
      cursor = result.cursor;
    }
    expect(seen.size).toBe(25);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot resume past them'),
    );
  });
});

describe('episodeDocument', () => {
  const ITEM = {
    title: 'Episode 12: Something',
    link: 'https://show.test/12',
    guid: 'tag:show.test,2026:12',
    author: 'Ada Hosting and Grace Cohost',
    feedTitle: 'The Test Show',
    pubDate: 'Mon, 06 Jul 2026 10:00:00 GMT',
    enclosure: { url: 'https://cdn.test/12.mp3', type: 'audio/mpeg', length: 42_000_000 },
  };

  it('emits an audio document with no inline text', () => {
    const document = episodeDocument(ITEM);
    expect(document).toEqual({
      id: expect.stringMatching(/^podcast-/),
      title: 'Episode 12: Something',
      author: 'The Test Show',
      url: 'https://show.test/12',
      date: '2026-07-06T10:00:00.000Z',
      audio_url: 'https://cdn.test/12.mp3',
    });
    expect(document.text).toBeUndefined();
  });

  it('attributes to the show, not the hosts', () => {
    expect(episodeDocument(ITEM).author).toBe('The Test Show');
  });

  it('falls back to the item author when the channel has no title', () => {
    expect(episodeDocument({ ...ITEM, feedTitle: '' }).author).toBe('Ada Hosting and Grace Cohost');
  });

  it('gives the same id across syncs for the same episode', () => {
    expect(episodeDocument(ITEM).id).toBe(episodeDocument({ ...ITEM }).id);
  });

  it('decodes entities in the title', () => {
    expect(episodeDocument({ ...ITEM, title: 'Bell &amp; Co.' }).title).toBe('Bell & Co.');
  });

  it('falls back to the audio URL when the item links no episode page', () => {
    expect(episodeDocument({ ...ITEM, link: '' }).url).toBe('https://cdn.test/12.mp3');
  });

  it('skips an item with no enclosure', () => {
    expect(episodeDocument({ ...ITEM, enclosure: undefined })).toBeUndefined();
  });

  it('skips a video episode', () => {
    const enclosure = { url: 'https://cdn.test/12.mp4', type: 'video/mp4' };
    expect(episodeDocument({ ...ITEM, enclosure })).toBeUndefined();
  });

  it('skips a non-media enclosure', () => {
    const enclosure = { url: 'https://cdn.test/notes.pdf', type: 'application/pdf' };
    expect(episodeDocument({ ...ITEM, enclosure })).toBeUndefined();
  });

  it('accepts an untyped enclosure whose URL is audio, through a tracking prefix', () => {
    const enclosure = { url: 'https://chrt.fm/track/ABC/cdn.test/12.mp3?updated=99', type: '' };
    expect(episodeDocument({ ...ITEM, enclosure }).audio_url).toBe(enclosure.url);
  });

  it('skips an untyped enclosure with no audio extension', () => {
    const enclosure = { url: 'https://cdn.test/download/12', type: '' };
    expect(episodeDocument({ ...ITEM, enclosure })).toBeUndefined();
  });
});
