import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

import * as feedSync from '../../lib/feed-sync.mjs';

mock.module('../../lib/feed-sync.mjs', () => ({
  ...feedSync,
  syncFeeds: mock(() => ({ documents: [], cursor: undefined, stats: { fetched: 0 } })),
}));

import { syncFeeds } from '../../lib/feed-sync.mjs';
import { sync } from './index.mjs';

function makeContext(config = {}) {
  return { log: { info: mock(), warn: mock() }, progress: mock(), config, cursor: undefined };
}

function optionsFor(config) {
  sync(makeContext(config));
  return syncFeeds.mock.calls.at(-1)[1];
}

describe('financial-times source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('defaults to five sections', () => {
    expect(optionsFor({}).feeds).toHaveLength(5);
  });

  it('builds the ?format=rss section URL', () => {
    expect(optionsFor({ sections: ['technology'] }).feeds[0].url).toBe(
      'https://www.ft.com/technology?format=rss',
    );
  });

  it('builds documents with the ft id prefix and default author', () => {
    const document = optionsFor({ sections: ['world'] }).toDocument({
      title: 'Story',
      link: 'https://ft.test/1',
      guid: 'https://ft.test/1',
      description: 'x',
    });
    expect(document.id).toMatch(/^ft-/);
    expect(document.author).toBe('Financial Times');
  });
});
