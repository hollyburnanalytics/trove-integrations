import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.
import * as realFeeds from '../../lib/feeds.mjs';

mock.module('../../lib/feeds.mjs', () => ({ ...realFeeds, syncRSS: mock() }));

import { syncRSS } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

describe('simon-willison source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('calls syncRSS with correct config', async () => {
    syncRSS.mockResolvedValue({ documents: [], cursor: undefined, stats: { fetched: 0 } });
    const context = {
      log: { info: mock(), warn: mock() },
      progress: mock(),
      config: {},
      cursor: undefined,
    };
    await sync(context);

    expect(syncRSS).toHaveBeenCalledWith(context, {
      feedUrl: 'https://simonwillison.net/atom/everything/',
      idPrefix: 'sw',
      defaultAuthor: 'Simon Willison',
    });
  });
});
