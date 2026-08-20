import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterAll(() => vi.restoreAllMocks());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.

vi.mock('../lib/feeds.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  syncRSS: vi.fn(),
}));

import { syncRSS } from '../lib/feeds.mjs';
import { makeSyncContext } from '../lib/test-fixtures.mjs';
import source from './index.mjs';

const sync = source.sync.bind(source);

describe('simon-willison source', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('calls syncRSS with correct config', async () => {
    vi.mocked(syncRSS).mockResolvedValue({
      documents: [],
      cursor: undefined,
      stats: { fetched: 0 },
    });
    const context = makeSyncContext();
    await sync(context);

    expect(syncRSS).toHaveBeenCalledWith(context, {
      feedUrl: 'https://simonwillison.net/atom/everything/',
      idPrefix: 'sw',
      defaultAuthor: 'Simon Willison',
    });
  });
});
