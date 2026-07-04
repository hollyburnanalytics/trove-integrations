import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

mock.module('../../lib/feeds.mjs', () => ({ syncRSS: mock() }));

import { syncRSS } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

describe('daring-fireball source', () => {
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
      feedUrl: 'https://daringfireball.net/feeds/main',
      idPrefix: 'df',
      defaultAuthor: 'John Gruber',
    });
  });
});
