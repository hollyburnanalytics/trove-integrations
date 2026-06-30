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

describe('rss-feeds connector', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('maps each configured feed URL to a feed descriptor', () => {
    const options = optionsFor({ feeds: ['https://a.test/feed', 'https://b.test/rss'] });
    expect(options.feeds).toEqual([{ url: 'https://a.test/feed' }, { url: 'https://b.test/rss' }]);
    expect(options.emptyWarning).toBe('No feeds configured');
  });

  it('passes no feeds when none configured', () => {
    expect(optionsFor({}).feeds).toEqual([]);
  });

  it('builds documents with the rss id prefix', () => {
    const document = optionsFor({ feeds: ['https://a.test/feed'] }).toDocument({
      title: 'Post',
      link: 'https://a.test/p',
      guid: 'https://a.test/p',
      description: 'Body',
    });
    expect(document.id).toMatch(/^rss-/);
    expect(document.title).toBe('Post');
  });
});
