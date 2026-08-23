import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterAll(() => vi.restoreAllMocks());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.

vi.mock('../lib/feeds.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  syncFeedArticles: vi.fn(),
}));

import { syncFeedArticles } from '../lib/feeds.ts';
import { makeSourceContext, syncOf } from '../lib/test-fixtures.ts';
import extension from './extension.ts';

const sync = syncOf(extension);

describe('our-world-in-data source', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('calls syncFeedArticles with correct config', async () => {
    const expected = { documents: [], cursor: undefined, stats: { fetched: 0 } };
    vi.mocked(syncFeedArticles).mockResolvedValue(expected);
    const context = makeSourceContext();

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
