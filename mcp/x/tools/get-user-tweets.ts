import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import {
  MEDIA_EXPANSION,
  MEDIA_FIELDS,
  strOrNull,
  TWEET_FIELDS,
  USER_FIELDS_BASIC,
  xGet,
} from '../client.ts';
import { costNote } from '../cost.ts';
import { includeToExclude, POST_TYPES } from '../post-types.ts';
import { tweetShape } from '../shapes.ts';
import { indexMedia, indexUsers, mapTweet, tweetLine } from '../tweets.ts';
import { cleanUsername, resolveTimelineUser } from '../users.ts';

/**
 * `get_user_tweets` — a person's recent posts by handle. Resolves the @handle to
 * an id (cached, billable once per warm isolate) and returns their timeline,
 * choosing originals/reposts/replies via `include`.
 */
export const getUserTweets: ToolDefinition = {
  name: 'get_user_tweets',
  title: 'X: Get a user’s recent posts',
  description:
    'Fetch a person’s recent posts by handle. Resolves the @handle to an id, ' +
    'then returns their timeline with clean text, a canonical x.com URL, author, ' +
    'created_at, like/repost/reply counts, and any attached media. Choose which ' +
    'post types you want with `include` (default: originals only); page newer ' +
    'with `since_id` or older with `pagination_token` (surfaced as `next_token`). ' +
    'NOTE: this endpoint always returns originals and can only ADD reposts/replies ' +
    '— it can’t return replies-only or reposts-only (use `search_posts` with ' +
    '`post_types` for that, e.g. older than 7 days too). Long posts return full ' +
    'text and t.co links are expanded. Cost: $0.010 for the one-time handle→id ' +
    'lookup (cached per warm isolate) + $0.005 per post returned — so a call bills ' +
    'about $0.010 + max_results×$0.005; size `max_results` accordingly.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    username: z.string().min(1).describe('X handle, with or without a leading @.'),
    max_results: z.number().int().min(5).max(100).default(10).describe('Max posts (5–100).'),
    include: z
      .array(z.enum(POST_TYPES))
      .default(['posts'])
      .describe(
        'Which post types to include: any of "posts" (originals), "reposts", ' +
          '"replies". Default ["posts"] = originals only. Originals are always ' +
          'returned; selecting reposts/replies adds them.',
      ),
    since_id: z
      .string()
      .optional()
      .describe('Only return posts newer than this tweet id (for paging forward).'),
    pagination_token: z
      .string()
      .optional()
      .describe('Page through older posts using a prior call’s `next_token`.'),
  }),
  output: z.object({
    user: z.object({
      id: z.string(),
      name: z.string().nullable(),
      username: z.string().nullable(),
      url: z.string().nullable(),
      verified: z.boolean().nullable(),
    }),
    count: z.number(),
    tweets: z.array(tweetShape),
    next_token: z.string().optional(),
    note: z.string(),
  }),
  async handler(args, ctx) {
    const username = cleanUsername(args.username);
    if (!username) throw new ToolError('Provide a non-empty username.', { retryable: false });
    ctx.log('get_user_tweets', {
      username,
      max_results: args.max_results,
      include: args.include,
    });
    // Resolving a handle is a billable user lookup; reuse a cached id when we
    // have one (and only bill for it on a cache miss).
    const { userId, user, resolvedNow } = await resolveTimelineUser(username, ctx);

    const params = new URLSearchParams({
      max_results: String(args.max_results),
      'tweet.fields': TWEET_FIELDS,
      expansions: `author_id,${MEDIA_EXPANSION}`,
      'user.fields': USER_FIELDS_BASIC,
      'media.fields': MEDIA_FIELDS,
    });
    const exclude = includeToExclude(args.include);
    if (exclude) params.set('exclude', exclude);
    if (args.since_id) params.set('since_id', args.since_id);
    if (args.pagination_token) params.set('pagination_token', args.pagination_token);

    const body = await xGet(`/2/users/${encodeURIComponent(userId)}/tweets`, params, ctx);
    const users = indexUsers(body.includes);
    const media = indexMedia(body.includes);
    const rawTweets = Array.isArray(body.data) ? body.data : [];
    const tweets = rawTweets.map((t) => mapTweet(t as Record<string, unknown>, users, media));
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    const nextToken = strOrNull(meta.next_token) ?? undefined;
    const note = costNote(tweets.length, resolvedNow ? 1 : 0);

    if (tweets.length === 0) {
      return {
        text: `@${username} has no recent posts matching the filter.\n${note}`,
        structured: { user, count: 0, tweets: [], next_token: nextToken, note },
      };
    }
    return {
      text:
        `@${username} — ${tweets.length} recent post(s):\n` +
        `${tweets.map((t) => tweetLine(t)).join('\n')}\n${note}`,
      structured: { user, count: tweets.length, tweets, next_token: nextToken, note },
    };
  },
};
