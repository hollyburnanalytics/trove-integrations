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
  rssItemXml({ title: 'Story', link: 'https://ft.test/1', description: 'x' }),
]);

describe('financial-times source', () => {
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

  it('builds the ?format=rss section URL', async () => {
    respondWith(STORY);
    await sync(makeContext({ sections: ['technology'] }));
    expect(fetchedUrls(fetchMock())).toEqual(['https://www.ft.com/technology?format=rss']);
  });

  it('builds documents with the ft id prefix and default author', async () => {
    respondWith(STORY);
    const result = await sync(makeContext({ sections: ['world'] }));
    expect(at(result.documents, 0).id).toMatch(/^ft-/);
    expect(at(result.documents, 0).author).toBe('Financial Times');
  });
});
