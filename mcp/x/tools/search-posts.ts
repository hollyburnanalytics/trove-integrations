import { type ToolDefinition, z } from '@ontrove/mcp';
import {
  MEDIA_EXPANSION,
  MEDIA_FIELDS,
  strOrNull,
  TWEET_FIELDS,
  USER_FIELDS_BASIC,
  xGet,
} from '../client.ts';
import { costNote } from '../cost.ts';
import { applyPostTypes, POST_TYPES } from '../post-types.ts';
import { tweetShape } from '../shapes.ts';
import { indexMedia, indexUsers, mapTweet, tweetLine } from '../tweets.ts';

/**
 * `search_posts` — search X with its operators over the recent (7-day) window or
 * the full archive back to 2006, with an optional post-type filter.
 */
export const searchPosts: ToolDefinition = {
  name: 'search_posts',
  title: 'X: Search posts (recent or full archive)',
  description:
    'Search posts using X search operators (e.g. "from:nasa", ' +
    '"#hurricane lang:en -is:retweet"). `scope` controls recency vs archive: ' +
    'recent = last 7 days (cheapest); archive = full history back to 2006 — use ' +
    'for anything older than 7 days. Returns matching posts with author, URL, ' +
    'created_at, metrics and any attached media. Optionally bound by ISO ' +
    'start/end time and order by recency or relevancy; page with ' +
    '`pagination_token` (surfaced as `next_token`). Use `post_types` to filter ' +
    'by originals/reposts/replies without hand-writing is:/-is: operators. Cost: ' +
    '$0.005 per post returned (no user lookup) — i.e. max_results×$0.005, either scope.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().min(1).describe('X search query (supports search operators).'),
    scope: z
      .enum(['recent', 'archive'])
      .default('recent')
      .describe(
        'recent = last 7 days (cheapest); archive = full history back to 2006 — ' +
          'use for anything older than 7 days.',
      ),
    post_types: z
      .array(z.enum(POST_TYPES))
      .optional()
      .describe(
        'Optional filter by post type: any of "posts" (originals), "reposts", ' +
          '"replies". Appends the matching is:/-is: operators to `query` (e.g. ' +
          '["posts"] → originals only; ["replies"] → replies only). Omit for no filter.',
      ),
    max_results: z.number().int().min(10).max(100).default(10).describe('Max posts (10–100).'),
    start_time: z
      .string()
      .optional()
      .describe('Oldest post timestamp, ISO 8601 (e.g. 2026-06-20T00:00:00Z).'),
    end_time: z
      .string()
      .optional()
      .describe('Newest post timestamp, ISO 8601 (e.g. 2026-06-27T00:00:00Z).'),
    sort_order: z
      .enum(['recency', 'relevancy'])
      .optional()
      .describe('Order results by recency (default) or relevancy.'),
    pagination_token: z
      .string()
      .optional()
      .describe('Page through more results using a prior call’s `next_token`.'),
  }),
  output: z.object({
    query: z.string(),
    count: z.number(),
    tweets: z.array(tweetShape),
    next_token: z.string().optional(),
    note: z.string(),
  }),
  async handler(args, ctx) {
    const query = applyPostTypes(args.query, args.post_types);
    ctx.log('search_posts', {
      query,
      scope: args.scope,
      max_results: args.max_results,
    });
    const params = new URLSearchParams({
      query,
      max_results: String(args.max_results),
      'tweet.fields': TWEET_FIELDS,
      expansions: `author_id,${MEDIA_EXPANSION}`,
      'user.fields': USER_FIELDS_BASIC,
      'media.fields': MEDIA_FIELDS,
    });
    if (args.start_time) params.set('start_time', args.start_time);
    if (args.end_time) params.set('end_time', args.end_time);
    if (args.sort_order) params.set('sort_order', args.sort_order);
    if (args.pagination_token) params.set('pagination_token', args.pagination_token);

    const path = args.scope === 'archive' ? '/2/tweets/search/all' : '/2/tweets/search/recent';
    const body = await xGet(path, params, ctx);
    const users = indexUsers(body.includes);
    const media = indexMedia(body.includes);
    const rawTweets = Array.isArray(body.data) ? body.data : [];
    const tweets = rawTweets.map((t) => mapTweet(t as Record<string, unknown>, users, media));
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    const nextToken = strOrNull(meta.next_token) ?? undefined;
    const note = costNote(tweets.length, 0);

    if (tweets.length === 0) {
      return {
        text: `No recent posts for "${query}".\n${note}`,
        structured: { query, count: 0, tweets: [], next_token: nextToken, note },
      };
    }
    return {
      text:
        `${tweets.length} recent post(s) for "${query}":\n` +
        `${tweets.map((t) => `${t.author ?? '?'}:${tweetLine(t)}`).join('\n')}\n${note}`,
      structured: {
        query,
        count: tweets.length,
        tweets,
        next_token: nextToken,
        note,
      },
    };
  },
};
