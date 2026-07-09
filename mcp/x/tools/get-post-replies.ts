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
import { tweetShape } from '../shapes.ts';
import { indexMedia, indexUsers, mapTweet, parseTweetId, snippet, tweetLine } from '../tweets.ts';

/**
 * `get_post_replies` — the reply thread under a post. Resolves the post's
 * conversation id, then pulls the thread via recent or full-archive search.
 */
export const getPostReplies: ToolDefinition = {
  name: 'get_post_replies',
  title: 'X: Get a post’s reply thread',
  description:
    'Given a post (raw id or x.com/twitter.com status URL), return the conversation ' +
    'under it — what people are saying in reply. Resolves the post’s conversation ' +
    'id first (so a reply’s URL still maps to its thread), surfaces the post you ' +
    'passed as `root`, and returns the thread’s replies (the author’s own ' +
    'follow-ups included — the whole thread). `scope`: recent = last 7 days ' +
    '(cheapest); archive = full history back to 2006 — use for posts older than 7 ' +
    'days. Page with `pagination_token`. Cost: $0.005 for the root lookup + $0.005 ' +
    'per reply returned.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    id_or_url: z
      .string()
      .min(1)
      .describe('A tweet id (e.g. "1899…") or an x.com/twitter.com status URL.'),
    scope: z
      .enum(['recent', 'archive'])
      .default('recent')
      .describe(
        'recent = last 7 days (cheapest); archive = full history back to 2006 — ' +
          'use for posts older than 7 days.',
      ),
    max_results: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(20)
      .describe('Max replies to return (10–100).'),
    pagination_token: z
      .string()
      .optional()
      .describe('Page through more replies using a prior call’s `next_token`.'),
  }),
  output: z.object({
    conversation_id: z.string(),
    root: tweetShape.nullable(),
    count: z.number(),
    replies: z.array(tweetShape),
    next_token: z.string().optional(),
    note: z.string(),
  }),
  async handler(args, ctx) {
    const id = parseTweetId(args.id_or_url);
    if (!id) {
      throw new ToolError(`Could not parse a tweet id from "${args.id_or_url}".`, {
        retryable: false,
      });
    }
    ctx.log('get_post_replies', { id, scope: args.scope, max_results: args.max_results });

    // 1) Resolve the conversation id (and capture the post itself) so that a
    //    reply's URL still maps to its whole thread.
    const rootParams = new URLSearchParams({
      ids: id,
      'tweet.fields': `${TWEET_FIELDS},conversation_id`,
      expansions: `author_id,${MEDIA_EXPANSION}`,
      'user.fields': USER_FIELDS_BASIC,
      'media.fields': MEDIA_FIELDS,
    });
    const rootBody = await xGet('/2/tweets', rootParams, ctx);
    const rootRaw = Array.isArray(rootBody.data) ? rootBody.data : [];
    if (rootRaw.length === 0) {
      throw new ToolError(`Tweet ${id} not found (or not accessible).`, { retryable: false });
    }
    const rootTweetRaw = rootRaw[0] as Record<string, unknown>;
    const root = mapTweet(
      rootTweetRaw,
      indexUsers(rootBody.includes),
      indexMedia(rootBody.includes),
    );
    const conversationId = strOrNull(rootTweetRaw.conversation_id) ?? id;

    // 2) Pull the thread by conversation id (recent vs full-archive search).
    const params = new URLSearchParams({
      query: `conversation_id:${conversationId}`,
      max_results: String(args.max_results),
      'tweet.fields': TWEET_FIELDS,
      expansions: `author_id,${MEDIA_EXPANSION}`,
      'user.fields': USER_FIELDS_BASIC,
      'media.fields': MEDIA_FIELDS,
    });
    if (args.pagination_token) params.set('pagination_token', args.pagination_token);
    const path = args.scope === 'archive' ? '/2/tweets/search/all' : '/2/tweets/search/recent';
    const body = await xGet(path, params, ctx);
    const users = indexUsers(body.includes);
    const media = indexMedia(body.includes);
    const rawTweets = Array.isArray(body.data) ? body.data : [];
    // Drop the post we already surfaced as `root` so it isn't duplicated.
    const replies = rawTweets
      .map((t) => mapTweet(t as Record<string, unknown>, users, media))
      .filter((t) => t.id !== root.id);
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    const nextToken = strOrNull(meta.next_token) ?? undefined;
    // Root lookup ($0.005) + each reply read ($0.005).
    const note = costNote(1 + replies.length, 0);

    if (replies.length === 0) {
      return {
        text: `No replies found for ${root.url ?? id} (conversation ${conversationId}).\n${note}`,
        structured: {
          conversation_id: conversationId,
          root,
          count: 0,
          replies: [],
          next_token: nextToken,
          note,
        },
      };
    }
    return {
      text:
        `${root.author ?? '?'} ${root.createdAt ? `[${root.createdAt}] ` : ''}${snippet(root.text)}\n` +
        `  ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} in the thread:\n` +
        `${replies.map((t) => `${t.author ?? '?'}:${tweetLine(t)}`).join('\n')}\n${note}`,
      structured: {
        conversation_id: conversationId,
        root,
        count: replies.length,
        replies,
        next_token: nextToken,
        note,
      },
    };
  },
};
