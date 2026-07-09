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

async function optionsFor(config) {
  await sync(makeContext(config));
  return syncFeeds.mock.calls.at(-1)[1];
}

describe('rss-feeds source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('maps each configured feed URL to a feed descriptor', async () => {
    const options = await optionsFor({ feeds: ['https://a.test/feed', 'https://b.test/rss'] });
    expect(options.feeds).toEqual([{ url: 'https://a.test/feed' }, { url: 'https://b.test/rss' }]);
    expect(options.emptyWarning).toBe('No feeds configured');
  });

  it('passes no feeds when none configured', async () => {
    const options = await optionsFor({});
    expect(options.feeds).toEqual([]);
  });

  it('builds documents with the rss id prefix', async () => {
    const options = await optionsFor({ feeds: ['https://a.test/feed'] });
    const document = options.toDocument({
      title: 'Post',
      link: 'https://a.test/p',
      guid: 'https://a.test/p',
      description: 'Body',
    });
    expect(document.id).toMatch(/^rss-/);
    expect(document.title).toBe('Post');
  });
});
