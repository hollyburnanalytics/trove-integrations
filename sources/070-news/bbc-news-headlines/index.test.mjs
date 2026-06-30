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

describe('bbc-news connector', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('defaults to five sections', () => {
    expect(optionsFor({}).feeds).toHaveLength(5);
  });

  it('maps top_stories to the base feed URL', () => {
    expect(optionsFor({ sections: ['top_stories'] }).feeds[0].url).toBe(
      'https://feeds.bbci.co.uk/news/rss.xml',
    );
  });

  it('maps a named section to its feed URL', () => {
    expect(optionsFor({ sections: ['technology'] }).feeds[0].url).toBe(
      'https://feeds.bbci.co.uk/news/technology/rss.xml',
    );
  });

  it('tags documents with the section and defaults the author', () => {
    const options = optionsFor({ sections: ['world'] });
    const document = options.toDocument(
      { title: 'Story', link: 'https://bbc.test/1', guid: 'https://bbc.test/1', description: 'x' },
      options.feeds[0],
    );
    expect(document.id).toMatch(/^bbc-/);
    expect(document.author).toBe('BBC News');
    expect(document.tags).toEqual(['world']);
  });
});
