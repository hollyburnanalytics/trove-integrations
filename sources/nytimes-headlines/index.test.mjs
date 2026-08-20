import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  at,
  fetchedUrls,
  fetchMock,
  makeSyncContext,
  okResponse,
  rssFeedXml,
  rssItemXml,
  setFetch,
} from '../lib/test-fixtures.mjs';
import source from './index.mjs';

const sync = source.sync.bind(source);

const ORIGINAL_FETCH = globalThis.fetch;

const makeContext = (config = {}) => makeSyncContext({ config });

/**
 * Answer every request with `xml`.
 *
 * @param {string} xml - The feed body.
 * @returns {void} Nothing; it installs the mock.
 */
function respondWith(xml) {
  setFetch(() => Promise.resolve(okResponse(xml)));
}

const STORY = rssFeedXml([
  rssItemXml({ title: 'Story', link: 'https://nyt.test/1', description: 'x' }),
]);

describe('nytimes source', () => {
  beforeEach(() => {
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('defaults to the HomePage feed', async () => {
    respondWith(STORY);
    await sync(makeContext({}));
    expect(fetchedUrls(fetchMock())).toEqual([
      'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    ]);
  });

  it('builds a feed URL per configured section', async () => {
    respondWith(STORY);
    await sync(makeContext({ sections: ['Technology'] }));
    expect(fetchedUrls(fetchMock())).toEqual([
      'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    ]);
  });

  it('builds documents with the nyt id prefix and default author', async () => {
    respondWith(STORY);
    const result = await sync(makeContext({}));
    expect(at(result.documents, 0).id).toMatch(/^nyt-/);
    expect(at(result.documents, 0).author).toBe('The New York Times');
  });
});
