import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchedUrls, okResponse, rssFeedXml, rssItemXml } from '../../lib/feed-fixtures.mjs';
import { sync } from './index.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

function makeContext(config = {}) {
  return { log: { info: vi.fn(), warn: vi.fn() }, progress: vi.fn(), config, cursor: undefined };
}

function respondWith(xml) {
  globalThis.fetch = vi.fn(() => Promise.resolve(okResponse(xml)));
}

const STORY = rssFeedXml([
  rssItemXml({ title: 'Story', link: 'https://nyt.test/1', description: 'x' }),
]);

describe('nytimes source', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('defaults to the HomePage feed', async () => {
    respondWith(STORY);
    await sync(makeContext({}));
    expect(fetchedUrls(globalThis.fetch)).toEqual([
      'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    ]);
  });

  it('builds a feed URL per configured section', async () => {
    respondWith(STORY);
    await sync(makeContext({ sections: ['Technology'] }));
    expect(fetchedUrls(globalThis.fetch)).toEqual([
      'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    ]);
  });

  it('builds documents with the nyt id prefix and default author', async () => {
    respondWith(STORY);
    const result = await sync(makeContext({}));
    expect(result.documents[0].id).toMatch(/^nyt-/);
    expect(result.documents[0].author).toBe('The New York Times');
  });
});
