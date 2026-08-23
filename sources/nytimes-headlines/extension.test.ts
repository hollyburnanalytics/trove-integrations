import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  at,
  fetchedUrls,
  fetchMock,
  makeSourceContext,
  okResponse,
  rssFeedXml,
  rssItemXml,
  setFetch,
  syncOf,
} from '../lib/test-fixtures.ts';
import extension from './extension.ts';

const sync = syncOf(extension);

const ORIGINAL_FETCH = globalThis.fetch;

const makeContext = (config = {}) => makeSourceContext({ config });

/**
 * Answer every request with `xml`.
 *
 * @param xml - The feed body.
 * @returns Nothing; it installs the mock.
 */
function respondWith(xml: string): void {
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
