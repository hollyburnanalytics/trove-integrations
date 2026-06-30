import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

mock.module('../../lib/feeds.mjs', () => ({
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

describe('lennys-newsletter connector', () => {
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
      feedUrl: 'https://www.lennysnewsletter.com/feed',
      idPrefix: 'lenny',
      defaultAuthor: 'Lenny Rachitsky',
    });
    expect(result).toBe(expected);
  });
});
