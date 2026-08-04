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

const STORY = rssFeedXml([
  rssItemXml({ title: 'Story', link: 'https://ft.test/1', description: 'x' }),
]);

describe('financial-times source', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('defaults to five sections', async () => {
    respondWith(STORY);
    await sync(makeContext({}));
    expect(fetchedUrls(globalThis.fetch)).toHaveLength(5);
  });

  it('builds the ?format=rss section URL', async () => {
    respondWith(STORY);
    await sync(makeContext({ sections: ['technology'] }));
    expect(fetchedUrls(globalThis.fetch)).toEqual(['https://www.ft.com/technology?format=rss']);
  });

  it('builds documents with the ft id prefix and default author', async () => {
    respondWith(STORY);
    const result = await sync(makeContext({ sections: ['world'] }));
    expect(result.documents[0].id).toMatch(/^ft-/);
    expect(result.documents[0].author).toBe('Financial Times');
  });
});
