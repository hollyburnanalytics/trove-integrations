import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { MEDIA_EXPANSION, MEDIA_FIELDS, TWEET_FIELDS, USER_FIELDS_BASIC, xGet } from '../client.ts';
import { costNote } from '../cost.ts';
import { tweetShape } from '../shapes.ts';
import {
  indexMedia,
  indexTweets,
  indexUsers,
  mapReferencedTweets,
  mapTweet,
  parseTweetId,
  snippet,
} from '../tweets.ts';

/**
 * `get_tweet` — expand one post by id or x.com URL, optionally resolving its
 * quoted/replied-to references.
 */
export const getTweet: ToolDefinition = {
  name: 'get_tweet',
  title: 'X: Get one post',
  description:
    'Expand one post by raw tweet id OR an x.com/twitter.com status URL (the ' +
    'trailing numeric id is parsed out). Returns the post with author, URL, ' +
    'created_at and metrics; with `expand_referenced` (default true) it also ' +
    'resolves any quoted or replied-to post’s text. Cost: $0.005 for the post + ' +
    '$0.005 per referenced (quoted/replied) post resolved.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    id_or_url: z
      .string()
      .min(1)
      .describe('A tweet id (e.g. "1899…") or an x.com/twitter.com status URL.'),
    expand_referenced: z
      .boolean()
      .default(true)
      .describe('Resolve quoted/replied-to posts referenced by this one.'),
  }),
  output: z.object({
    tweet: tweetShape,
    referenced: z.array(tweetShape.extend({ type: z.string().nullable() })),
    note: z.string(),
  }),
  async handler(args, ctx) {
    const id = parseTweetId(args.id_or_url);
    if (!id) {
      throw new ToolError(`Could not parse a tweet id from "${args.id_or_url}".`, {
        retryable: false,
      });
    }
    ctx.log('get_tweet', { id, expand_referenced: args.expand_referenced });
    const params = new URLSearchParams({
      ids: id,
      'tweet.fields': `${TWEET_FIELDS},conversation_id`,
      expansions: `author_id,referenced_tweets.id,referenced_tweets.id.author_id,${MEDIA_EXPANSION}`,
      'user.fields': USER_FIELDS_BASIC,
      'media.fields': MEDIA_FIELDS,
    });
    const body = await xGet('/2/tweets', params, ctx);
    const rawTweets = Array.isArray(body.data) ? body.data : [];
    if (rawTweets.length === 0) {
      throw new ToolError(`Tweet ${id} not found (or not accessible).`, { retryable: false });
    }
    const users = indexUsers(body.includes);
    const media = indexMedia(body.includes);
    const tweetsIndex = indexTweets(body.includes);
    const rawTweet = rawTweets[0] as Record<string, unknown>;
    const tweet = mapTweet(rawTweet, users, media);

    const referenced = args.expand_referenced
      ? mapReferencedTweets(rawTweet, tweetsIndex, users, media)
      : [];

    const note = costNote(1 + referenced.length, 0);
    const refLines = referenced.map((r) => `  ↳ ${r.type ?? 'ref'}: ${snippet(r.text)}`).join('\n');
    return {
      text:
        `${tweet.author ?? '?'} ${tweet.createdAt ? `[${tweet.createdAt}] ` : ''}${snippet(tweet.text)}\n` +
        `  ${tweet.likes ?? 0} likes, ${tweet.reposts ?? 0} reposts, ${tweet.replies ?? 0} replies` +
        `${refLines ? `\n${refLines}` : ''}\n${note}`,
      structured: { tweet, referenced, note },
    };
  },
};
