import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, idSetCursor, makeSourceContext, setFetch, syncOf } from '../lib/test-fixtures.ts';
import type { Cursor, SourceContext } from '../lib/types.js';
import extension from './extension.ts';

const sync = syncOf(extension);

/**
 * Every test mocks `fetch` — the network is never touched. The source runs
 * the OAuth refresh-token grant, resolves the user id, then pages bookmarks;
 * the mock answers each of those three endpoints.
 */

/** The credentials this source needs, as the harness would supply them. */
const SECRETS: Record<string, string> = {
  X_OAUTH_CLIENT_ID: 'client-id-123',
  X_OAUTH_REFRESH_TOKEN: 'refresh-token-abc',
};

/**
 * A context carrying the two credentials this source requires.
 *
 * @param cursor - The previous run's cursor.
 * @param secrets - What `ctx.secret()` resolves from.
 * @returns The context.
 */
const makeContext = (cursor?: Cursor, secrets: Record<string, string> = SECRETS): SourceContext =>
  makeSourceContext({
    secrets,
    cursor,
  });

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

/** One bookmarked post, as the API returns it. */
type Tweet = {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  public_metrics: Record<string, number>;
  entities: { hashtags: Array<{ tag: string }> } | undefined;
};

/** One page of the bookmarks endpoint's response. */
type Page = {
  data?: Tweet[];
  includes?: typeof USERS;
  meta?: { result_count?: number; next_token?: string };
};

/**
 * One bookmarked post, as the API returns it.
 *
 * @param id - The post's id.
 * @param text - Its body.
 * @param authorId - Whose it is, joined against `includes.users`.
 * @param hashtags - Its hashtag entities.
 * @returns The post.
 */
function tweet(id: string, text: string, authorId: string, hashtags: string[] = []): Tweet {
  return {
    id,
    text,
    author_id: authorId,
    created_at: '2026-06-28T10:00:00.000Z',
    public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
    entities: hashtags.length > 0 ? { hashtags: hashtags.map((tag) => ({ tag })) } : undefined,
  };
}

/**
 * A JSON response, as far as this source reads one.
 *
 * @param body - What `.json()` resolves to.
 * @param status - The status code; `ok` follows from it, as it does
 *   on a real Response — there is no such thing as a 404 that succeeded.
 * @returns The response.
 */
function jsonResponse(body: unknown, status: number = 200): Promise<Response> {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/** What the installed fetch mock should answer with. */
type FetchMockOptions = {
  /** The grant's status code; whether it succeeded follows from it. */
  tokenStatus?: number;
  /** One body per bookmarks request, in order. */
  pages?: Page[];
};

/**
 * Install a fetch mock answering token / users-me / bookmarks (paged).
 *
 * @param options - What the mock should answer with.
 * @returns Every URL requested, in call order.
 */
function installFetch({ tokenStatus = 200, pages = [] }: FetchMockOptions = {}): string[] {
  const calls: string[] = [];
  let pageIndex = 0;
  setFetch((url) => {
    calls.push(url);
    if (url.includes('/2/oauth2/token')) return jsonResponse(TOKEN_BODY, tokenStatus);
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

describe('x-bookmarks source', () => {
  beforeEach(() => {
    setFetch();
  });
  afterEach(() => vi.restoreAllMocks());

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
    const first = at(result.documents);
    expect(String(first.id).startsWith('x-bm-')).toBe(true); // stable, prefixed id
    expect(first.url).toBe('https://x.com/elonmusk/status/1900000000000000100');
    expect(first.author).toBe('@elonmusk');
    expect(first.tags).toEqual(['databases']);
    expect(first.title).toBe('A thread about #databases');
    expect(at(result.documents, 1).author).toBe('@chefjack');

    expect(result.cursor?.type).toBe('idSet');
    expect(idSetCursor(result.cursor).values).toEqual([
      '1900000000000000100',
      '1900000000000000101',
    ]);
    expect(result.stats?.fetched).toBe(2);
    expect(result.stats?.skipped).toBe(0);
  });

  // The cursor this source wrote before the shape was corrected: the set under
  // `value` rather than `values`. Still read, for one release, so upgrading does
  // not throw away a Mac user's position and re-fetch every bookmark.
  it('still resumes from a LEGACY `value` cursor', async () => {
    // Not a `Cursor` — that is the point of this test. The legacy shape is
    // asserted as the source will really meet it on a Mac being upgraded.
    const cursor = {
      type: 'idSet',
      value: ['1900000000000000100', '1900000000000000101'],
    } as unknown as Cursor;
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
    expect(at(result.documents, 0).url).toBe('https://x.com/elonmusk/status/1900000000000000102');
    expect(result.stats?.fetched).toBe(1);
    // The seen head + the one after it on the page are counted as skipped.
    expect(result.stats?.skipped).toBe(2);
    // Newest-first, prior set appended, deduped.
    expect(idSetCursor(result.cursor).values).toEqual([
      '1900000000000000102',
      '1900000000000000100',
      '1900000000000000101',
    ]);
  });

  it('resumes from the corrected `values` cursor', async () => {
    // The shape the platform can actually parse. `parseWatermark` requires
    // `values`, so the old cursor read as null in the cloud — this source would
    // have re-fetched every bookmark on every run the moment it left the Mac.
    const cursor: Cursor = {
      type: 'idSet',
      values: ['1900000000000000100', '1900000000000000101'],
      max: 1000,
    };
    installFetch({
      pages: [
        {
          data: [
            tweet('1900000000000000102', 'Brand new bookmark', '44196397'),
            tweet('1900000000000000100', 'A thread about databases', '44196397'),
          ],
          includes: USERS,
        },
      ],
    });

    const result = await sync(makeContext(cursor));

    expect(result.documents).toHaveLength(1);
    expect(at(idSetCursor(result.cursor).values)).toBe('1900000000000000102');
    // The cap travels with the set, which is what lets a reader say whether the
    // set is full and therefore evicting.
    expect(idSetCursor(result.cursor).max).toBe(1000);
  });

  it('throws a token-free error when the refresh grant is rejected', async () => {
    installFetch({ tokenStatus: 400 });
    await expect(sync(makeContext())).rejects.toThrow(/X_OAUTH_REFRESH_TOKEN/);
    await expect(sync(makeContext())).rejects.not.toThrow(/refresh-token-abc/);
  });

  it('throws, naming the credential, when a required one is missing', async () => {
    // `requireSecret` raises per credential rather than listing both, so the
    // message names the one actually absent instead of restating the pair.
    await expect(sync(makeContext(undefined, {}))).rejects.toThrow(/X_OAUTH_CLIENT_ID/);
    await expect(
      sync(makeContext(undefined, { X_OAUTH_CLIENT_ID: 'client-id-123' })),
    ).rejects.toThrow(/X_OAUTH_REFRESH_TOKEN/);
  });
});
