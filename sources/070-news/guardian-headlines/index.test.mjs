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

describe('guardian connector', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('defaults to four sections', () => {
    expect(optionsFor({}).feeds).toHaveLength(4);
  });

  it('builds the /rss section URL', () => {
    expect(optionsFor({ sections: ['technology'] }).feeds[0].url).toBe(
      'https://www.theguardian.com/technology/rss',
    );
  });

  it('uses category tags and strips the boilerplate "Continue reading" link', () => {
    const document = optionsFor({ sections: ['world'] }).toDocument({
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
