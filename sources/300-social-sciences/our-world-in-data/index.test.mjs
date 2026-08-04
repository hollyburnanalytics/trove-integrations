import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.
import * as realFeeds from '../../lib/feeds.mjs';

mock.module('../../lib/feeds.mjs', () => ({
  ...realFeeds,
  syncFeedArticles: mock(),
}));

import { syncFeedArticles } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

describe('our-world-in-data source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('calls syncFeedArticles with correct config', async () => {
    const expected = { documents: [], cursor: undefined, stats: { fetched: 0 } };
    syncFeedArticles.mockResolvedValue(expected);
    const context = {
      log: { info: mock(), warn: mock() },
      progress: mock(),
      config: {},
      cursor: undefined,
    };

    const result = await sync(context);

    expect(syncFeedArticles).toHaveBeenCalledWith(context, {
      feedUrl: 'https://ourworldindata.org/atom.xml',
      idPrefix: 'owid',
      defaultAuthor: 'Our World in Data',
      articleSelector: 'article.centered-article-container',
    });
    expect(result).toBe(expected);
  });
});
