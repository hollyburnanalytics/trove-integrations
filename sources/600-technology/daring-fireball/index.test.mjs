import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterAll(() => vi.restoreAllMocks());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.

vi.mock('../../lib/feeds.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  syncRSS: vi.fn(),
}));

import { syncRSS } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

describe('daring-fireball source', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('calls syncRSS with correct config', async () => {
    syncRSS.mockResolvedValue({ documents: [], cursor: undefined, stats: { fetched: 0 } });
    const context = {
      log: { info: vi.fn(), warn: vi.fn() },
      progress: vi.fn(),
      config: {},
      cursor: undefined,
    };
    await sync(context);

    expect(syncRSS).toHaveBeenCalledWith(context, {
      feedUrl: 'https://daringfireball.net/feeds/main',
      idPrefix: 'df',
      defaultAuthor: 'John Gruber',
    });
  });
});
