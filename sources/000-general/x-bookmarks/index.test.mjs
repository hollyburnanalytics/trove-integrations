import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { sync } from './index.mjs';

/**
 * Every test mocks `fetch` — the network is never touched. The connector runs
 * the OAuth refresh-token grant, resolves the user id, then pages bookmarks;
 * the mock answers each of those three endpoints.
 */

function makeContext(cursor) {
  return {
    log: { info: mock(), warn: mock() },
    progress: mock(),
    config: {},
    credentials: {
      X_OAUTH_CLIENT_ID: 'client-id-123',
      X_OAUTH_REFRESH_TOKEN: 'refresh-token-abc',
    },
    cursor,
  };
}

const TOKEN_BODY = {
  token_type: 'bearer',
  expires_in: 7200,
  access_token: 'access-token-xyz',
  refresh_token: 'rotated-refresh-token',
};

const ME_BODY = { data: { id: '44196397', username: 'elonmusk', name: 'Elon Musk' } };

const USERS = {
  users: [
    { id: '44196397', username: 'elonmusk', name: 'Elon Musk' },
    { id: '12', username: 'chefjack', name: 'Chef Jack' },
  ],
};

function tweet(id, text, authorId, hashtags = []) {
  return {
    id,
    text,
    author_id: authorId,
    created_at: '2026-06-28T10:00:00.000Z',
    public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
    entities: hashtags.length > 0 ? { hashtags: hashtags.map((tag) => ({ tag })) } : undefined,
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

/** Install a fetch mock answering token / users-me / bookmarks (paged). */
function installFetch({ tokenOk = true, tokenStatus = 200, pages = [] } = {}) {
  const calls = [];
  let pageIndex = 0;
  globalThis.fetch = mock((url) => {
    calls.push(url);
    if (url.includes('/2/oauth2/token')) return jsonResponse(TOKEN_BODY, tokenOk, tokenStatus);
    if (url.includes('/bookmarks')) {
      const body = pages[pageIndex] ?? { data: [] };
      pageIndex += 1;
      return jsonResponse(body);
    }
    if (url.includes('/2/users/me')) return jsonResponse(ME_BODY);
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

describe('x-bookmarks connector', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => jest.restoreAllMocks());

  it('refreshes OAuth, ingests bookmarks and sets the idSet cursor on first sync', async () => {
    const calls = installFetch({
      pages: [
        {
          data: [
            tweet('1900000000000000100', 'A thread about #databases', '44196397', ['databases']),
            tweet('1900000000000000101', 'Cooking tips from a chef', '12'),
          ],
          includes: USERS,
          meta: { result_count: 2 },
        },
      ],
    });

    const result = await sync(makeContext());

    // The refresh-token grant ran before any X API read.
    expect(calls.some((url) => url.includes('/2/oauth2/token'))).toBe(true);
    expect(calls.some((url) => url.includes('/2/users/44196397/bookmarks'))).toBe(true);

    expect(result.documents).toHaveLength(2);
    const first = result.documents[0];
    expect(first.id.startsWith('x-bm-')).toBe(true); // stable, prefixed id
    expect(first.url).toBe('https://x.com/elonmusk/status/1900000000000000100');
    expect(first.author).toBe('@elonmusk');
    expect(first.tags).toEqual(['databases']);
    expect(first.title).toBe('A thread about #databases');
    expect(result.documents[1].author).toBe('@chefjack');

    expect(result.cursor.type).toBe('idSet');
    expect(result.cursor.value).toEqual(['1900000000000000100', '1900000000000000101']);
    expect(result.stats.fetched).toBe(2);
    expect(result.stats.skipped).toBe(0);
  });

  it('stops at the first already-seen id and ingests only the new ones', async () => {
    const cursor = { type: 'idSet', value: ['1900000000000000100', '1900000000000000101'] };
    installFetch({
      pages: [
        {
          // A new bookmark on top, then the previously-seen head.
          data: [
            tweet('1900000000000000102', 'Brand new bookmark', '44196397'),
            tweet('1900000000000000100', 'A thread about databases', '44196397'),
            tweet('1900000000000000101', 'Cooking tips from a chef', '12'),
          ],
          includes: USERS,
          meta: { next_token: 'SHOULD_NOT_BE_FETCHED' },
        },
        // A second page exists, but we must never request it (we stop at the seen id).
        { data: [tweet('1900000000000000099', 'older, should be skipped', '12')], includes: USERS },
      ],
    });

    const result = await sync(makeContext(cursor));

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].url).toBe('https://x.com/elonmusk/status/1900000000000000102');
    expect(result.stats.fetched).toBe(1);
    // The seen head + the one after it on the page are counted as skipped.
    expect(result.stats.skipped).toBe(2);
    // Newest-first, prior set appended, deduped.
    expect(result.cursor.value).toEqual([
      '1900000000000000102',
      '1900000000000000100',
      '1900000000000000101',
    ]);
  });

  it('throws a token-free error when the refresh grant is rejected', async () => {
    installFetch({ tokenOk: false, tokenStatus: 400 });
    await expect(sync(makeContext())).rejects.toThrow(/X_OAUTH_REFRESH_TOKEN/);
    await expect(sync(makeContext())).rejects.not.toThrow(/refresh-token-abc/);
  });

  it('throws when required OAuth credentials are missing', async () => {
    const context = makeContext();
    context.credentials = {};
    await expect(sync(context)).rejects.toThrow(/X_OAUTH_CLIENT_ID and X_OAUTH_REFRESH_TOKEN/);
  });
});
