import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

mock.module('../../lib/feeds.mjs', () => ({
  syncFeedArticles: mock(),
}));

import { syncFeedArticles } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

describe('quanta-magazine connector', () => {
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
      feedUrl: 'https://www.quantamagazine.org/feed/',
      idPrefix: 'quanta',
      defaultAuthor: 'Quanta Magazine',
      articleSelector: '.post__content__section.wysiwyg',
    });
    expect(result).toBe(expected);
  });
});
