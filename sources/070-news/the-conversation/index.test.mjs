import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

// Spread the real module: replacing it wholesale would strip stableId/safeDate/
// decodeHtmlEntities for every OTHER test file too — Bun's module mock registry is
// process-global and keyed by specifier string.
import * as realFeeds from '../../lib/feeds.mjs';

mock.module('../../lib/feeds.mjs', () => ({
  ...realFeeds,
  syncRSS: mock(),
}));

import { syncRSS } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

function makeContext() {
  return {
    log: { info: mock(), warn: mock() },
    progress: mock(),
    config: {},
    cursor: undefined,
  };
}

describe('the-conversation source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('calls syncRSS with correct config', async () => {
    const expected = {
      documents: [{ id: '1', title: 'Test' }],
      cursor: undefined,
      stats: { fetched: 1 },
    };
    syncRSS.mockResolvedValue(expected);

    const context = makeContext();
    const result = await sync(context);

    expect(syncRSS).toHaveBeenCalledWith(context, {
      feedUrl: 'https://theconversation.com/articles.atom',
      idPrefix: 'tc',
      defaultAuthor: 'The Conversation',
    });
    expect(result).toBe(expected);
  });
});
