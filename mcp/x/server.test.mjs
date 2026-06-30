import { beforeEach, describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server, { __resetBookmarkAuth, __resetUserCache } from './server.ts';

/**
 * X API v2 reads carry a static app-only Bearer Token, resolved by the SDK via
 * the `/internal/secret` callback (satisfied here by `withSecret`). Every test
 * mocks `fetch`; the network is never touched.
 */

const USER_BY_NAME = {
  data: { id: '44196397', name: 'Elon Musk', username: 'elonmusk', verified: true },
};

const PROFILE_BY_NAME = {
  data: {
    id: '44196397',
    name: 'Elon Musk',
    username: 'elonmusk',
    verified: true,
    description: 'Technoking',
    location: 'Texas',
    created_at: '2009-06-02T20:12:29.000Z',
    profile_image_url: 'https://pbs.twimg.com/elon.jpg',
    public_metrics: {
      followers_count: 200_000_000,
      following_count: 900,
      tweet_count: 40_000,
      listed_count: 150_000,
    },
  },
};

const TIMELINE = {
  data: [
    {
      id: '1900000000000000001',
      text: 'Hello from the timeline',
      author_id: '44196397',
      created_at: '2026-06-20T12:00:00.000Z',
      public_metrics: { like_count: 100, retweet_count: 20, reply_count: 5, quote_count: 2 },
    },
    {
      id: '1900000000000000002',
      text: 'Second post',
      author_id: '44196397',
      created_at: '2026-06-19T12:00:00.000Z',
      public_metrics: { like_count: 50, retweet_count: 10, reply_count: 1, quote_count: 0 },
    },
  ],
  includes: {
    users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk', verified: true }],
  },
};

const TWEET_WITH_REF = {
  data: [
    {
      id: '1900000000000000010',
      text: 'Quoting an interesting post',
      author_id: '44196397',
      created_at: '2026-06-21T08:00:00.000Z',
      conversation_id: '1900000000000000010',
      public_metrics: { like_count: 10, retweet_count: 2, reply_count: 0, quote_count: 0 },
      referenced_tweets: [{ type: 'quoted', id: '1899999999999999999' }],
    },
  ],
  includes: {
    users: [
      { id: '44196397', name: 'Elon Musk', username: 'elonmusk', verified: true },
      { id: '12', name: 'Jack', username: 'jack', verified: false },
    ],
    tweets: [
      {
        id: '1899999999999999999',
        text: 'The original quoted post',
        author_id: '12',
        created_at: '2026-06-20T07:00:00.000Z',
        public_metrics: { like_count: 999, retweet_count: 100, reply_count: 50, quote_count: 30 },
      },
    ],
  },
};

const SEARCH_BODY = {
  data: [
    {
      id: '1900000000000000020',
      text: 'A post about hurricanes',
      author_id: '99',
      created_at: '2026-06-25T00:00:00.000Z',
      public_metrics: { like_count: 7, retweet_count: 3, reply_count: 1, quote_count: 0 },
    },
  ],
  includes: {
    users: [{ id: '99', name: 'Weather Bot', username: 'weatherbot', verified: false }],
  },
};

/**
 * Drive `get_user_tweets` with a given `include` (omitted → default) and return
 * the `exclude` query param X received, or undefined when none was sent.
 */
async function excludeParameterFor(include) {
  let url = '';
  await callTool(
    server,
    'get_user_tweets',
    include === undefined ? { username: 'elonmusk' } : { username: 'elonmusk', include },
    withSecret('test-token', (u) => {
      if (u.includes('/2/users/by/username/')) return { json: USER_BY_NAME };
      url = u;
      return { json: TIMELINE };
    }),
  );
  __resetUserCache();
  const m = /[?&]exclude=([^&]*)/.exec(decodeURIComponent(url));
  return m ? m[1] : undefined;
}

describe('x MCP server', () => {
  it('lists exactly the seven tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'count_posts',
      'get_bookmarks',
      'get_post_replies',
      'get_tweet',
      'get_user_tweets',
      'resolve_user',
      'search_posts',
    ]);
  });

  describe('get_user_tweets', () => {
    // The handle→id cache is module-level; reset it so each test starts cold.
    beforeEach(() => __resetUserCache());

    it('resolves the handle, maps tweets, joins the author and builds canonical URLs', async () => {
      const result = await callTool(
        server,
        'get_user_tweets',
        { username: '@elonmusk', max_results: 10 },
        withSecret('test-token', (url) => {
          if (url.includes('/2/users/by/username/')) return { json: USER_BY_NAME };
          return { json: TIMELINE };
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.user.id).toBe('44196397');
      expect(s.user.username).toBe('elonmusk');
      expect(s.count).toBe(2);

      const first = s.tweets[0];
      expect(first.id).toBe('1900000000000000001');
      expect(first.text).toBe('Hello from the timeline');
      expect(first.url).toBe('https://x.com/elonmusk/status/1900000000000000001');
      expect(first.author).toBe('@elonmusk');
      expect(first.authorName).toBe('Elon Musk');
      expect(first.createdAt).toBe('2026-06-20T12:00:00.000Z');
      expect(first.likes).toBe(100);
      expect(first.reposts).toBe(20);
      expect(first.replies).toBe(5);
      expect(s.note).toMatch(/meters reads/i);
    });

    it('sends the Bearer token, include→exclude, max_results and since_id on the request', async () => {
      let auth;
      let timelineUrl = '';
      await callTool(
        server,
        'get_user_tweets',
        {
          username: 'elonmusk',
          max_results: 25,
          include: ['posts'],
          since_id: '123',
        },
        withSecret('secret-bearer', (url, init) => {
          if (url.includes('/2/users/by/username/')) return { json: USER_BY_NAME };
          timelineUrl = url;
          const h = init?.headers;
          auth = h instanceof Headers ? h.get('authorization') : h?.authorization;
          return { json: TIMELINE };
        }),
      );
      expect(auth).toBe('Bearer secret-bearer');
      const decoded = decodeURIComponent(timelineUrl);
      expect(decoded).toContain('/2/users/44196397/tweets');
      expect(decoded).toContain('max_results=25');
      // include:['posts'] (originals only) drops both replies and retweets.
      expect(decoded).toContain('exclude=replies,retweets');
      expect(decoded).toContain('since_id=123');
      expect(decoded).toContain('expansions=author_id');
    });

    it('maps include selections to the right X exclude param', async () => {
      // Default (omitted) = originals only → drop replies + retweets.
      expect(await excludeParameterFor()).toBe('replies,retweets');
      expect(await excludeParameterFor(['posts'])).toBe('replies,retweets');
      expect(await excludeParameterFor(['posts', 'reposts'])).toBe('replies');
      expect(await excludeParameterFor(['posts', 'replies'])).toBe('retweets');
      // Everything selected → no exclude param at all.
      expect(await excludeParameterFor(['posts', 'reposts', 'replies'])).toBeUndefined();
    });

    it('reports a not-found handle as a non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_user_tweets',
        { username: 'ghost' },
        withSecret('test-token', { json: { errors: [{ detail: 'Could not find user' }] } }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('returns the full note_tweet body for a long (>280-char) post', async () => {
      const longText = `Long post ${'x'.repeat(400)} end`;
      const NOTE_TIMELINE = {
        data: [
          {
            id: '1900000000000000300',
            // X truncates the legacy `text` field at 280 chars with an ellipsis.
            text: `${longText.slice(0, 277)}…`,
            author_id: '44196397',
            created_at: '2026-06-20T12:00:00.000Z',
            note_tweet: { text: longText },
            public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
          },
        ],
        includes: { users: TIMELINE.includes.users },
      };
      const result = await callTool(
        server,
        'get_user_tweets',
        { username: 'elonmusk' },
        withSecret('test-token', (url) =>
          url.includes('/2/users/by/username/') ? { json: USER_BY_NAME } : { json: NOTE_TIMELINE },
        ),
      );
      expect(result.ok).toBe(true);
      const tweet = result.result.structured.tweets[0];
      expect(tweet.text).toBe(longText);
      expect(tweet.text.length).toBeGreaterThan(280);
      expect(tweet.text).not.toContain('…');
    });

    it('expands t.co links to their real destination using entities', async () => {
      const TCO_TIMELINE = {
        data: [
          {
            id: '1900000000000000301',
            text: 'Read this https://t.co/abc123 now',
            author_id: '44196397',
            entities: {
              urls: [
                {
                  url: 'https://t.co/abc123',
                  expanded_url: 'https://example.com/the-real-article',
                  display_url: 'example.com/the-real…',
                },
              ],
            },
            public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
          },
        ],
        includes: { users: TIMELINE.includes.users },
      };
      const result = await callTool(
        server,
        'get_user_tweets',
        { username: 'elonmusk' },
        withSecret('test-token', (url) =>
          url.includes('/2/users/by/username/') ? { json: USER_BY_NAME } : { json: TCO_TIMELINE },
        ),
      );
      expect(result.ok).toBe(true);
      const tweet = result.result.structured.tweets[0];
      expect(tweet.text).toBe('Read this https://example.com/the-real-article now');
      expect(tweet.text).not.toContain('t.co');
    });

    it('surfaces attached media (type + alt) joined from includes.media', async () => {
      const MEDIA_TIMELINE = {
        data: [
          {
            id: '1900000000000000302',
            text: 'A photo post',
            author_id: '44196397',
            attachments: { media_keys: ['3_111'] },
            public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
          },
        ],
        includes: {
          users: TIMELINE.includes.users,
          media: [
            {
              media_key: '3_111',
              type: 'photo',
              url: 'https://pbs.twimg.com/media/photo.jpg',
              alt_text: 'a sunset over the ocean',
            },
          ],
        },
      };
      let requested = '';
      const result = await callTool(
        server,
        'get_user_tweets',
        { username: 'elonmusk' },
        withSecret('test-token', (url) => {
          if (url.includes('/2/users/by/username/')) return { json: USER_BY_NAME };
          requested = url;
          return { json: MEDIA_TIMELINE };
        }),
      );
      expect(result.ok).toBe(true);
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('media.fields=type,url,preview_image_url,alt_text');
      expect(decoded).toContain('attachments.media_keys');
      const tweet = result.result.structured.tweets[0];
      expect(tweet.media).toHaveLength(1);
      expect(tweet.media[0].type).toBe('photo');
      expect(tweet.media[0].alt).toBe('a sunset over the ocean');
      expect(tweet.media[0].url).toBe('https://pbs.twimg.com/media/photo.jpg');
    });

    it('forwards pagination_token and surfaces next_token', async () => {
      const PAGED_TIMELINE = { ...TIMELINE, meta: { next_token: 'TIMELINEPAGE2' } };
      let requested = '';
      const result = await callTool(
        server,
        'get_user_tweets',
        { username: 'elonmusk', pagination_token: 'PTOKEN' },
        withSecret('test-token', (url) => {
          if (url.includes('/2/users/by/username/')) return { json: USER_BY_NAME };
          requested = url;
          return { json: PAGED_TIMELINE };
        }),
      );
      expect(result.ok).toBe(true);
      expect(decodeURIComponent(requested)).toContain('pagination_token=PTOKEN');
      expect(result.result.structured.next_token).toBe('TIMELINEPAGE2');
    });

    it('resolves the handle only once across repeat calls (id cache)', async () => {
      let resolveCalls = 0;
      const responder = withSecret('test-token', (url) => {
        if (url.includes('/2/users/by/username/')) {
          resolveCalls += 1;
          return { json: USER_BY_NAME };
        }
        return { json: TIMELINE };
      });
      const first = await callTool(server, 'get_user_tweets', { username: 'elonmusk' }, responder);
      // Different casing + leading @ must still hit the same cached id.
      const second = await callTool(
        server,
        'get_user_tweets',
        { username: '@ElonMusk' },
        responder,
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(resolveCalls).toBe(1);
      expect(second.result.structured.user.id).toBe('44196397');
      // The first call bills a lookup; the cached call drops it from the read tally.
      expect(first.result.structured.note).toContain('read 2 posts + 1 user lookup ≈ $0.020');
      expect(second.result.structured.note).toContain('read 2 posts ≈ $0.010');
      expect(second.result.structured.note).not.toContain('+ 1 user lookup');
    });
  });

  describe('get_tweet', () => {
    it('expands one tweet and resolves its quoted reference', async () => {
      const result = await callTool(
        server,
        'get_tweet',
        { id_or_url: '1900000000000000010' },
        withSecret('test-token', { json: TWEET_WITH_REF }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.tweet.id).toBe('1900000000000000010');
      expect(s.tweet.author).toBe('@elonmusk');
      expect(s.tweet.url).toBe('https://x.com/elonmusk/status/1900000000000000010');
      expect(s.referenced).toHaveLength(1);
      expect(s.referenced[0].type).toBe('quoted');
      expect(s.referenced[0].id).toBe('1899999999999999999');
      expect(s.referenced[0].text).toBe('The original quoted post');
      expect(s.referenced[0].author).toBe('@jack');
      expect(s.note).toMatch(/meters reads/i);
    });

    it('parses the trailing numeric id out of an x.com status URL', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'get_tweet',
        { id_or_url: 'https://x.com/elonmusk/status/1900000000000000010?s=20' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: TWEET_WITH_REF };
        }),
      );
      expect(result.ok).toBe(true);
      expect(decodeURIComponent(requested)).toContain('ids=1900000000000000010');
    });

    it('omits referenced tweets when expand_referenced is false', async () => {
      const result = await callTool(
        server,
        'get_tweet',
        { id_or_url: '1900000000000000010', expand_referenced: false },
        withSecret('test-token', { json: TWEET_WITH_REF }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.referenced).toHaveLength(0);
    });

    it('treats an empty data array as not found (non-retryable)', async () => {
      const result = await callTool(
        server,
        'get_tweet',
        { id_or_url: '1900000000000000099' },
        withSecret('test-token', { json: { data: [] } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('rejects an input with no parseable id before fetching', async () => {
      const result = await callTool(server, 'get_tweet', { id_or_url: 'not-a-tweet' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.error).toMatch(/could not parse/i);
    });
  });

  describe('get_post_replies', () => {
    const ROOT_LOOKUP = {
      data: [
        {
          id: '1900000000000000010',
          text: 'The original post everyone is replying to',
          author_id: '44196397',
          created_at: '2026-06-21T08:00:00.000Z',
          conversation_id: '1900000000000000010',
          public_metrics: { like_count: 100, retweet_count: 5, reply_count: 3, quote_count: 1 },
        },
      ],
      includes: {
        users: [{ id: '44196397', name: 'Elon Musk', username: 'elonmusk', verified: true }],
      },
    };

    const THREAD_BODY = {
      // A conversation_id search returns the root too; it must be filtered out.
      data: [
        {
          id: '1900000000000000010',
          text: 'The original post everyone is replying to',
          author_id: '44196397',
          created_at: '2026-06-21T08:00:00.000Z',
          public_metrics: { like_count: 100, retweet_count: 5, reply_count: 3, quote_count: 1 },
        },
        {
          id: '1900000000000000050',
          text: 'Great point!',
          author_id: '12',
          created_at: '2026-06-21T08:05:00.000Z',
          public_metrics: { like_count: 2, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
        {
          id: '1900000000000000051',
          text: 'I disagree though',
          author_id: '99',
          created_at: '2026-06-21T08:10:00.000Z',
          public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
      ],
      meta: { next_token: 'THREADPAGE2' },
      includes: {
        users: [
          { id: '44196397', name: 'Elon Musk', username: 'elonmusk', verified: true },
          { id: '12', name: 'Jack', username: 'jack', verified: false },
          { id: '99', name: 'Weather Bot', username: 'weatherbot', verified: false },
        ],
      },
    };

    // Branches the two calls: the root `ids=` lookup vs the conversation search.
    const responder = (capture) =>
      withSecret('test-token', (url) => {
        if (url.includes('/internal/secret')) return { json: {} };
        if (url.includes('/2/tweets/search/')) {
          capture.search = url;
          return { json: THREAD_BODY };
        }
        capture.root = url;
        return { json: ROOT_LOOKUP };
      });

    it('resolves the conversation id and returns the root + thread replies', async () => {
      const capture = {};
      const result = await callTool(
        server,
        'get_post_replies',
        { id_or_url: '1900000000000000010', max_results: 20 },
        responder(capture),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.conversation_id).toBe('1900000000000000010');
      expect(s.root.id).toBe('1900000000000000010');
      expect(s.root.author).toBe('@elonmusk');
      // The root post is filtered out of the replies list; 2 replies remain.
      expect(s.count).toBe(2);
      expect(s.replies.map((r) => r.id)).toEqual(['1900000000000000050', '1900000000000000051']);
      expect(s.replies.some((r) => r.id === s.root.id)).toBe(false);
      expect(s.next_token).toBe('THREADPAGE2');
      const decoded = decodeURIComponent(capture.search);
      expect(decoded).toContain('/2/tweets/search/recent');
      expect(decoded).toContain('query=conversation_id:1900000000000000010');
      // Root lookup ($0.005) + 2 replies ($0.005 each) = $0.015.
      expect(s.note).toContain('read 3 posts');
      expect(s.note).toContain('$0.015');
    });

    it('routes scope=archive to the full-archive search endpoint', async () => {
      const capture = {};
      await callTool(
        server,
        'get_post_replies',
        { id_or_url: '1900000000000000010', scope: 'archive' },
        responder(capture),
      );
      expect(decodeURIComponent(capture.search)).toContain('/2/tweets/search/all');
    });

    it('parses the tweet id out of an x.com status URL', async () => {
      const capture = {};
      const result = await callTool(
        server,
        'get_post_replies',
        { id_or_url: 'https://x.com/elonmusk/status/1900000000000000010?s=20' },
        responder(capture),
      );
      expect(result.ok).toBe(true);
      expect(decodeURIComponent(capture.root)).toContain('ids=1900000000000000010');
    });

    it('reports an unparseable id as a non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_post_replies',
        { id_or_url: 'not-a-tweet' },
        withSecret('test-token', { json: ROOT_LOOKUP }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/could not parse/i);
    });
  });

  describe('search_posts', () => {
    it('passes the query through and maps matching posts', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'search_posts',
        { query: '#hurricane lang:en', max_results: 10, sort_order: 'relevancy' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.query).toBe('#hurricane lang:en');
      expect(s.count).toBe(1);
      expect(s.tweets[0].author).toBe('@weatherbot');
      expect(s.tweets[0].url).toBe('https://x.com/weatherbot/status/1900000000000000020');
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/2/tweets/search/recent');
      expect(decoded).toContain('query=#hurricane+lang:en');
      expect(decoded).toContain('sort_order=relevancy');
    });

    it('defaults to the recent endpoint when no scope is given', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'search_posts',
        { query: '#hurricane' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/2/tweets/search/recent');
      expect(decoded).not.toContain('/2/tweets/search/all');
    });

    it('routes scope=archive to the full-archive endpoint', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'search_posts',
        { query: 'from:nasa', scope: 'archive', start_time: '2010-01-01T00:00:00Z' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      expect(decodeURIComponent(requested)).toContain('/2/tweets/search/all');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_posts',
        { query: 'zzznothingmatches' },
        withSecret('test-token', { json: { data: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no recent posts/i);
    });

    it('forwards pagination_token and surfaces next_token', async () => {
      const PAGED_SEARCH = { ...SEARCH_BODY, meta: { next_token: 'SEARCHPAGE2' } };
      let requested = '';
      const result = await callTool(
        server,
        'search_posts',
        { query: '#hurricane', pagination_token: 'STOKEN' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: PAGED_SEARCH };
        }),
      );
      expect(result.ok).toBe(true);
      expect(decodeURIComponent(requested)).toContain('pagination_token=STOKEN');
      expect(result.result.structured.next_token).toBe('SEARCHPAGE2');
    });

    it('appends post_types operators to the query (originals only)', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'search_posts',
        { query: 'from:bcherny', post_types: ['posts'], scope: 'archive' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('-is:reply');
      expect(decoded).toContain('-is:retweet');
      // The effective (filtered) query is echoed back to the caller.
      expect(result.result.structured.query).toBe('from:bcherny -is:reply -is:retweet');
    });

    it('builds a replies-only pull from post_types:["replies"]', async () => {
      let requested = '';
      await callTool(
        server,
        'search_posts',
        { query: 'from:bcherny', post_types: ['replies'] },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('is:reply');
      expect(decoded).toContain('-is:retweet');
      expect(decoded).not.toContain('-is:reply');
    });
  });

  describe('count_posts', () => {
    const COUNTS_BODY = {
      data: [
        { start: '2026-06-22T00:00:00.000Z', end: '2026-06-23T00:00:00.000Z', tweet_count: 10 },
        { start: '2026-06-23T00:00:00.000Z', end: '2026-06-24T00:00:00.000Z', tweet_count: 15 },
      ],
      meta: { total_tweet_count: 25 },
    };

    it('returns the total + buckets and prices the pull, without reading posts', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'count_posts',
        { query: 'from:bcherny' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: COUNTS_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.total).toBe(25);
      expect(s.buckets).toHaveLength(2);
      expect(s.buckets[0].count).toBe(10);
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/2/tweets/counts/recent');
      expect(decoded).toContain('granularity=day');
      // Flat per-request charge, and it prices the would-be pull (25 × $0.005).
      expect(s.note).toContain('Counts: Recent');
      expect(s.note).toContain('flat $0.005 per request');
      expect(s.note).toContain('$0.125');
      expect(result.result.text).toContain('25 post(s)');
    });

    it('routes scope=archive to the full-archive counts endpoint with the All fee', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'count_posts',
        { query: 'from:nasa', scope: 'archive' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: COUNTS_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/2/tweets/counts/all');
      const s = result.result.structured;
      // Archive counts bill the flat $0.010 fee, but still price the pull at $0.005/post.
      expect(s.note).toContain('Counts: All');
      expect(s.note).toContain('flat $0.010 per request');
      expect(s.note).toContain('$0.125');
      // Window label reflects the archive scope, not a hardcoded "last 7 days".
      expect(result.result.text).toContain('across the full archive');
      expect(result.result.text).not.toContain('last 7 days');
    });

    it('describes an explicit date range in the window label', async () => {
      const result = await callTool(
        server,
        'count_posts',
        {
          query: 'from:bcherny',
          scope: 'archive',
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-02-01T00:00:00Z',
        },
        withSecret('test-token', { json: COUNTS_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toContain('between 2026-01-01T00:00:00Z and 2026-02-01T00:00:00Z');
      expect(result.result.text).not.toContain('last 7 days');
    });

    it('falls back to summing buckets when meta omits the total', async () => {
      const result = await callTool(
        server,
        'count_posts',
        { query: 'nasa', granularity: 'hour' },
        withSecret('test-token', {
          json: {
            data: [
              { start: 'a', end: 'b', tweet_count: 3 },
              { start: 'b', end: 'c', tweet_count: 4 },
            ],
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.total).toBe(7);
    });

    it('applies post_types operators so it prices a matching typed pull', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'count_posts',
        { query: 'from:bcherny', post_types: ['posts'], scope: 'archive' },
        withSecret('test-token', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: COUNTS_BODY };
        }),
      );
      expect(result.ok).toBe(true);
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('-is:reply');
      expect(decoded).toContain('-is:retweet');
      expect(result.result.structured.query).toBe('from:bcherny -is:reply -is:retweet');
    });
  });

  describe('resolve_user', () => {
    it('maps a full profile', async () => {
      const result = await callTool(
        server,
        'resolve_user',
        { username: '@elonmusk' },
        withSecret('test-token', { json: PROFILE_BY_NAME }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.id).toBe('44196397');
      expect(s.name).toBe('Elon Musk');
      expect(s.username).toBe('elonmusk');
      expect(s.url).toBe('https://x.com/elonmusk');
      expect(s.bio).toBe('Technoking');
      expect(s.followers).toBe(200_000_000);
      expect(s.following).toBe(900);
      expect(s.tweetCount).toBe(40_000);
      expect(s.verified).toBe(true);
      expect(s.location).toBe('Texas');
      expect(s.profileImageUrl).toBe('https://pbs.twimg.com/elon.jpg');
      expect(s.note).toMatch(/user lookup/i);
    });
  });

  describe('get_bookmarks', () => {
    // The user-context flow caches the access + rotated refresh token in a
    // module-level variable; reset it so each test exercises a cold refresh.
    beforeEach(() => __resetBookmarkAuth());

    const OAUTH_SECRETS = {
      X_OAUTH_CLIENT_ID: 'client-id-123',
      X_OAUTH_REFRESH_TOKEN: 'refresh-token-abc',
      // X_OAUTH_CLIENT_SECRET intentionally absent → public client (no Basic auth).
    };

    const TOKEN_BODY = {
      token_type: 'bearer',
      expires_in: 7200,
      access_token: 'access-token-xyz',
      refresh_token: 'rotated-refresh-token',
      scope: 'tweet.read users.read bookmark.read offline.access',
    };

    const ME_BODY = { data: { id: '44196397', name: 'Elon Musk', username: 'elonmusk' } };

    const BOOKMARKS_BODY = {
      data: [
        {
          id: '1900000000000000100',
          text: 'A bookmarked thread about databases',
          author_id: '44196397',
          created_at: '2026-06-28T10:00:00.000Z',
          public_metrics: { like_count: 12, retweet_count: 3, reply_count: 1, quote_count: 0 },
        },
        {
          id: '1900000000000000101',
          text: 'Cooking tips from a chef',
          author_id: '12',
          created_at: '2026-06-27T09:00:00.000Z',
          public_metrics: { like_count: 5, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
      ],
      includes: {
        users: [
          { id: '44196397', name: 'Elon Musk', username: 'elonmusk' },
          { id: '12', name: 'Chef Jack', username: 'chefjack' },
        ],
      },
      meta: { result_count: 2, next_token: 'NEXTPAGE123' },
    };

    // Reply to the secret callback per-name (undefined ⇒ the secret is unset,
    // which the SDK treats as "no value", i.e. a missing optional secret).
    const secretValue = (init) => OAUTH_SECRETS[JSON.parse(init.body).name];

    /** A happy-path responder: secrets, token refresh, /users/me, bookmarks. */
    const okResponder = (url, init) => {
      if (url.includes('/internal/secret')) return { json: { value: secretValue(init) } };
      if (url.includes('/2/oauth2/token')) return { json: TOKEN_BODY };
      if (url.includes('/bookmarks')) return { json: BOOKMARKS_BODY };
      if (url.includes('/2/users/me')) return { json: ME_BODY };
      throw new Error(`unexpected fetch: ${url}`);
    };

    it('refreshes the token, maps bookmarks, joins authors and surfaces next_token', async () => {
      let tokenMethod;
      let tokenBody = '';
      let bookmarksAuth;
      let bookmarksUrl = '';
      const result = await callTool(server, 'get_bookmarks', { max_results: 25 }, (url, init) => {
        if (url.includes('/internal/secret')) return { json: { value: secretValue(init) } };
        if (url.includes('/2/oauth2/token')) {
          tokenMethod = init?.method;
          tokenBody = String(init?.body ?? '');
          return { json: TOKEN_BODY };
        }
        if (url.includes('/bookmarks')) {
          bookmarksUrl = url;
          const h = init?.headers;
          bookmarksAuth = h instanceof Headers ? h.get('authorization') : h?.authorization;
          return { json: BOOKMARKS_BODY };
        }
        if (url.includes('/2/users/me')) return { json: ME_BODY };
        throw new Error(`unexpected fetch: ${url}`);
      });

      expect(result.ok).toBe(true);
      // The refresh-token grant was POSTed with the right form fields.
      expect(tokenMethod).toBe('POST');
      expect(tokenBody).toContain('grant_type=refresh_token');
      expect(tokenBody).toContain('refresh_token=refresh-token-abc');
      expect(tokenBody).toContain('client_id=client-id-123');
      // The minted access token (not the app Bearer) is sent to the bookmarks API.
      expect(bookmarksAuth).toBe('Bearer access-token-xyz');
      const decoded = decodeURIComponent(bookmarksUrl);
      expect(decoded).toContain('/2/users/44196397/bookmarks');
      expect(decoded).toContain('max_results=25');

      const s = result.result.structured;
      expect(s.bookmarks).toHaveLength(2);
      expect(s.bookmarks[0].id).toBe('1900000000000000100');
      expect(s.bookmarks[0].url).toBe('https://x.com/elonmusk/status/1900000000000000100');
      expect(s.bookmarks[0].author).toBe('@elonmusk');
      expect(s.bookmarks[0].authorName).toBe('Elon Musk');
      expect(s.bookmarks[1].author).toBe('@chefjack');
      expect(s.next_token).toBe('NEXTPAGE123');
      expect(s.note).toMatch(/meters reads/i);
      expect(s.note).toContain('read 2 bookmarks');
      // Bookmarks are an "owned read" at $0.001, not the $0.005 post rate.
      expect(s.note).toContain('$0.001/bookmark (owned read)');
    });

    it('applies the client-side query filter over post text + author', async () => {
      const byText = await callTool(server, 'get_bookmarks', { query: 'DATABASE' }, okResponder);
      expect(byText.ok).toBe(true);
      expect(byText.result.structured.bookmarks).toHaveLength(1);
      expect(byText.result.structured.bookmarks[0].id).toBe('1900000000000000100');

      __resetBookmarkAuth();
      const byAuthor = await callTool(server, 'get_bookmarks', { query: 'chefjack' }, okResponder);
      expect(byAuthor.result.structured.bookmarks).toHaveLength(1);
      expect(byAuthor.result.structured.bookmarks[0].author).toBe('@chefjack');
    });

    it('maps a 400 invalid_grant on refresh to a non-retryable re-authorize error', async () => {
      const result = await callTool(server, 'get_bookmarks', {}, (url, init) => {
        if (url.includes('/internal/secret')) return { json: { value: secretValue(init) } };
        if (url.includes('/2/oauth2/token'))
          return { status: 400, json: { error: 'invalid_grant' } };
        throw new Error('must not call the X API after a failed token refresh');
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/re-run the authorize step/i);
      expect(result.error).toMatch(/X_OAUTH_REFRESH_TOKEN/);
      // The dead refresh token must never appear in the surfaced error.
      expect(result.error).not.toContain('refresh-token-abc');
    });
  });

  describe('auth errors', () => {
    it('maps a 401 to a non-retryable bearer-token error', async () => {
      const result = await callTool(
        server,
        'resolve_user',
        { username: 'elonmusk' },
        withSecret('bad-token', {
          status: 401,
          json: { title: 'Unauthorized', detail: 'Unauthorized' },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/X_BEARER_TOKEN/);
    });

    it('maps a 429 to a retryable rate-limit error', async () => {
      const result = await callTool(
        server,
        'search_posts',
        { query: 'anything' },
        withSecret('test-token', { status: 429, json: { title: 'Too Many Requests' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate limit/i);
    });
  });
});
