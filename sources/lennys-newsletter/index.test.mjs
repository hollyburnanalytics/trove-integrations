import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterAll(() => vi.restoreAllMocks());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.

vi.mock('../lib/feeds.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  syncRSS: vi.fn(),
}));

import { makeSyncContext } from '../lib/feed-fixtures.mjs';
import { syncRSS } from '../lib/feeds.mjs';
import { sync } from './index.mjs';

const makeContext = () => makeSyncContext();

describe('lennys-newsletter source', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('calls syncRSS with correct config', async () => {
    const expected = {
      documents: [{ id: '1', title: 'Test' }],
      cursor: undefined,
      stats: { fetched: 1 },
    };
    vi.mocked(syncRSS).mockResolvedValue(expected);

    const context = makeContext();
    const result = await sync(context);

    expect(syncRSS).toHaveBeenCalledWith(context, {
      feedUrl: 'https://www.lennysnewsletter.com/feed',
      idPrefix: 'lenny',
      defaultAuthor: 'Lenny Rachitsky',
    });
    expect(result).toBe(expected);
  });
});
