import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterAll(() => vi.restoreAllMocks());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.

vi.mock('../lib/feeds.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  syncFeedArticles: vi.fn(),
}));

import { syncFeedArticles } from '../lib/feeds.mjs';
import { makeSyncContext } from '../lib/test-fixtures.mjs';
import source from './index.mjs';

const sync = source.sync.bind(source);

describe('quanta-magazine source', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('calls syncFeedArticles with correct config', async () => {
    const expected = { documents: [], cursor: undefined, stats: { fetched: 0 } };
    vi.mocked(syncFeedArticles).mockResolvedValue(expected);
    const context = makeSyncContext();

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
