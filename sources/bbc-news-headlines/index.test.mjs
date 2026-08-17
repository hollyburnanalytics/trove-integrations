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
} from '../lib/feed-fixtures.mjs';
import { sync } from './index.mjs';

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
  rssItemXml({ title: 'Story', link: 'https://bbc.test/1', description: 'x' }),
]);

describe('bbc-news source', () => {
  beforeEach(() => {
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('defaults to five sections', async () => {
    respondWith(STORY);
    await sync(makeContext({}));
    expect(fetchedUrls(fetchMock())).toHaveLength(5);
  });

  it('maps top_stories to the base feed URL', async () => {
    respondWith(STORY);
    await sync(makeContext({ sections: ['top_stories'] }));
    expect(fetchedUrls(fetchMock())).toEqual(['https://feeds.bbci.co.uk/news/rss.xml']);
  });

  it('maps a named section to its feed URL', async () => {
    respondWith(STORY);
    await sync(makeContext({ sections: ['technology'] }));
    expect(fetchedUrls(fetchMock())).toEqual(['https://feeds.bbci.co.uk/news/technology/rss.xml']);
  });

  it('tags documents with the section and defaults the author', async () => {
    respondWith(STORY);
    const result = await sync(makeContext({ sections: ['world'] }));
    expect(at(result.documents, 0).id).toMatch(/^bbc-/);
    expect(at(result.documents, 0).author).toBe('BBC News');
    expect(at(result.documents, 0).tags).toEqual(['world']);
  });
});
