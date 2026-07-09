import { type ToolDefinition, z } from '@ontrove/mcp';
import {
  bookmarkOwnerCached,
  getBookmarkOwnerId,
  getUserAccessToken,
  REAUTH_MESSAGE,
} from '../auth.ts';
import { MEDIA_EXPANSION, MEDIA_FIELDS, strOrNull, TWEET_FIELDS, xGet } from '../client.ts';
import { costNote } from '../cost.ts';
import { tweetShape } from '../shapes.ts';
import { indexMedia, indexUsers, mapTweet, tweetLine } from '../tweets.ts';

/**
 * `get_bookmarks` — your own most-recent bookmarks via user-context OAuth (the
 * app-only Bearer cannot read them), with an optional client-side text filter.
 */
export const getBookmarks: ToolDefinition = {
  name: 'get_bookmarks',
  title: 'X: Get your bookmarks',
  description:
    'Fetch YOUR most recent X bookmarks (newest bookmark first). Returns each ' +
    'bookmarked post with clean text, a canonical x.com URL, author, created_at ' +
    'and like/repost/reply counts. X exposes only your ~800 most recent ' +
    'bookmarks; page forward with `pagination_token` (surfaced as `next_token`). ' +
    'The API has no bookmark search, so `query` is an optional client-side ' +
    'case-insensitive substring filter over post text + author. Cost: $0.001 per ' +
    'bookmark returned — an "owned read" (your own data), 5× cheaper than a post ' +
    'read — plus a one-time $0.010 user-id lookup per warm isolate; same-day ' +
    're-reads are free. Requires user-context OAuth (X_OAUTH_CLIENT_ID / ' +
    'X_OAUTH_REFRESH_TOKEN).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    max_results: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(25)
      .describe('Max bookmarks to read this page (10–100).'),
    pagination_token: z
      .string()
      .optional()
      .describe('Page forward using a prior call’s `next_token`.'),
    query: z
      .string()
      .optional()
      .describe('Optional case-insensitive substring filter over post text + author.'),
  }),
  output: z.object({
    bookmarks: z.array(tweetShape),
    next_token: z.string().optional(),
    note: z.string(),
  }),
  async handler(args, ctx) {
    ctx.log('get_bookmarks', {
      max_results: args.max_results,
      paged: Boolean(args.pagination_token),
      filtered: Boolean(args.query),
    });
    const accessToken = await getUserAccessToken(ctx);
    // The owner-id `/2/users/me` call is a one-time User:Read ($0.010) per warm
    // isolate; bill for it only when we actually resolve it (cache miss).
    const ownerCached = bookmarkOwnerCached();
    const userId = await getBookmarkOwnerId(ctx, accessToken);

    const params = new URLSearchParams({
      max_results: String(args.max_results),
      'tweet.fields': TWEET_FIELDS,
      expansions: `author_id,${MEDIA_EXPANSION}`,
      'user.fields': 'name,username',
      'media.fields': MEDIA_FIELDS,
    });
    if (args.pagination_token) params.set('pagination_token', args.pagination_token);

    const body = await xGet(`/2/users/${encodeURIComponent(userId)}/bookmarks`, params, ctx, {
      bearer: accessToken,
      unauthorizedMessage: REAUTH_MESSAGE,
    });
    const users = indexUsers(body.includes);
    const media = indexMedia(body.includes);
    const rawTweets = Array.isArray(body.data) ? body.data : [];
    const read = rawTweets.length;
    let bookmarks = rawTweets.map((t) => mapTweet(t as Record<string, unknown>, users, media));

    const q = args.query?.trim().toLowerCase();
    if (q) {
      bookmarks = bookmarks.filter(
        (b) =>
          b.text.toLowerCase().includes(q) ||
          (b.author?.toLowerCase().includes(q) ?? false) ||
          (b.authorName?.toLowerCase().includes(q) ?? false),
      );
    }

    const meta = (body.meta ?? {}) as Record<string, unknown>;
    const nextToken = strOrNull(meta.next_token) ?? undefined;
    // Bookmarks are ordinary Posts:Read ($0.005 each); add the one-time
    // user-id lookup ($0.010) only on a cache miss.
    const note = costNote(read, ownerCached ? 0 : 1, 'bookmark');

    if (bookmarks.length === 0) {
      const why = q ? ` matching "${args.query}"` : '';
      return {
        text: `No bookmarks${why}.\n${note}`,
        structured: { bookmarks: [], next_token: nextToken, note },
      };
    }
    return {
      text:
        `${bookmarks.length} bookmark(s):\n` +
        `${bookmarks.map((b) => `${b.author ?? '?'}:${tweetLine(b)}`).join('\n')}\n${note}`,
      structured: { bookmarks, next_token: nextToken, note },
    };
  },
};
