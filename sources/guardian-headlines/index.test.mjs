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
} from '../lib/test-fixtures.mjs';
import extension from './index.mjs';

const sync = syncOf(extension);

const ORIGINAL_FETCH = globalThis.fetch;

const makeContext = (config = {}) => makeSourceContext({ config });

/**
 * Answer every request with `xml`.
 *
 * @param {string} xml - The feed body.
 * @returns {void} Nothing; it installs the mock.
 */
function respondWith(xml) {
  setFetch(() => Promise.resolve(okResponse(xml)));
}

describe('guardian source', () => {
  beforeEach(() => {
    setFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('defaults to four sections', async () => {
    respondWith(rssFeedXml([rssItemXml({})]));
    await sync(makeContext({}));
    expect(fetchedUrls(fetchMock())).toHaveLength(4);
  });

  it('builds the /rss section URL', async () => {
    respondWith(rssFeedXml([rssItemXml({})]));
    await sync(makeContext({ sections: ['technology'] }));
    expect(fetchedUrls(fetchMock())).toEqual(['https://www.theguardian.com/technology/rss']);
  });

  it('uses category tags and strips the boilerplate "Continue reading" link', async () => {
    respondWith(
      rssFeedXml([
        rssItemXml({
          title: 'Story',
          link: 'https://guardian.test/1',
          // Exactly what the live feed carries: the anchor arrives tag-stripped,
          // so the boilerplate is plain text, not a markdown link.
          description: 'Summary Continue reading...',
          categories: ['World news', 'Politics'],
        }),
      ]),
    );
    const result = await sync(makeContext({ sections: ['world'] }));
    const document = at(result.documents);
    expect(document.id).toMatch(/^guardian-/);
    expect(document.tags).toEqual(['World news', 'Politics']);
    expect(document.text).not.toMatch(/Continue reading/i);
    expect(document.text).toContain('Summary');
  });
});
