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

describe('guardian source', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('defaults to four sections', async () => {
    const options = await optionsFor({});
    expect(options.feeds).toHaveLength(4);
  });

  it('builds the /rss section URL', async () => {
    const options = await optionsFor({ sections: ['technology'] });
    expect(options.feeds[0].url).toBe('https://www.theguardian.com/technology/rss');
  });

  it('uses category tags and strips the boilerplate "Continue reading" link', async () => {
    const options = await optionsFor({ sections: ['world'] });
    const document = options.toDocument({
      title: 'Story',
      link: 'https://guardian.test/1',
      guid: 'https://guardian.test/1',
      description: 'Summary [Continue reading...](https://guardian.test/1)',
      categories: ['World news', 'Politics'],
    });
    expect(document.id).toMatch(/^guardian-/);
    expect(document.tags).toEqual(['World news', 'Politics']);
    expect(document.text).not.toMatch(/Continue reading/i);
    expect(document.text).toContain('Summary');
  });
});
