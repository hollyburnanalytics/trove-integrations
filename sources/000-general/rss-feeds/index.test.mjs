import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fetchedUrls, okResponse, rssFeedXml, rssItemXml } from '../../lib/feed-fixtures.mjs';
import { sync } from './index.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

function makeContext(config = {}) {
  return { log: { info: mock(), warn: mock() }, progress: mock(), config, cursor: undefined };
}

function respondWith(xml) {
  globalThis.fetch = mock(() => Promise.resolve(okResponse(xml)));
}

describe('rss-feeds source', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('fetches each configured feed URL', async () => {
    respondWith(rssFeedXml([rssItemXml({})]));
    await sync(makeContext({ feeds: ['https://a.test/feed', 'https://b.test/rss'] }));
    expect(fetchedUrls(globalThis.fetch)).toEqual(['https://a.test/feed', 'https://b.test/rss']);
  });

  it('warns and fetches nothing when no feeds are configured', async () => {
    const context = makeContext({});
    const result = await sync(context);
    expect(context.log.warn).toHaveBeenCalledWith('No feeds configured');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.documents).toEqual([]);
  });

  it('builds documents with the rss id prefix', async () => {
    respondWith(
      rssFeedXml([rssItemXml({ title: 'Post', link: 'https://a.test/p', description: 'Body' })]),
    );
    const result = await sync(makeContext({ feeds: ['https://a.test/feed'] }));
    expect(result.documents[0].id).toMatch(/^rss-/);
    expect(result.documents[0].title).toBe('Post');
  });

  it('stores the fullest body the feed provides, not just the excerpt', async () => {
    respondWith(
      rssFeedXml([
        rssItemXml({
          description: 'Short excerpt',
          extra: '<content:encoded><![CDATA[<p>The whole post body</p>]]></content:encoded>',
        }),
      ]),
    );
    const result = await sync(makeContext({ feeds: ['https://a.test/feed'] }));
    expect(result.documents[0].text).toContain('The whole post body');
  });

  it('attaches the feed’s own categories as tags', async () => {
    respondWith(rssFeedXml([rssItemXml({ categories: ['Tech', 'Opinion'] })]));
    const result = await sync(makeContext({ feeds: ['https://a.test/feed'] }));
    expect(result.documents[0].tags).toEqual(['Tech', 'Opinion']);
  });
});
