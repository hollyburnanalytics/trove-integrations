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

describe('nytimes source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('defaults to the HomePage feed', async () => {
    const options = await optionsFor({});
    expect(options.feeds).toEqual([
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', label: 'HomePage' },
    ]);
  });

  it('builds a feed URL per configured section', async () => {
    const options = await optionsFor({ sections: ['Technology'] });
    expect(options.feeds[0].url).toBe(
      'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    );
  });

  it('builds documents with the nyt id prefix and default author', async () => {
    const options = await optionsFor({});
    const document = options.toDocument({
      title: 'Story',
      link: 'https://nyt.test/1',
      guid: 'https://nyt.test/1',
      description: 'x',
    });
    expect(document.id).toMatch(/^nyt-/);
    expect(document.author).toBe('The New York Times');
  });
});
