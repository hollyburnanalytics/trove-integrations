import { type ToolDefinition, z } from '@ontrove/mcp';
import { numOrNull, strOrNull, xGet } from '../client.ts';
import { POST_READ_USD } from '../cost.ts';
import { applyPostTypes, POST_TYPES } from '../post-types.ts';

/**
 * `count_posts` — how many posts match a query WITHOUT reading them, for a flat
 * per-request fee, so a `search_posts`/`get_user_tweets` pull can be priced first.
 */
export const countPosts: ToolDefinition = {
  name: 'count_posts',
  title: 'X: Count posts (price a search before pulling)',
  description:
    'Count how many posts match an X query WITHOUT reading the posts — use it to ' +
    'price a `search_posts`/`get_user_tweets` pull before you spend. `scope` ' +
    'controls the window: recent = last 7 days; archive = full history back to ' +
    '2006. Returns the total plus a time series by day/hour/minute. Cost: a FLAT ' +
    'per-request fee regardless of the total — $0.005/request for recent ' +
    '(Counts: Recent), $0.010/request for archive (Counts: All) — versus $0.005 ' +
    'PER post to actually read them, so counting is far cheaper than pulling. E.g. ' +
    'count "from:bcherny" → ~25 posts this week, so a full pull would cost ~$0.125. ' +
    'Pass `post_types` (same as `search_posts`) to price a type-filtered pull.',
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
          '"replies". Appends the same is:/-is: operators as `search_posts`, so a ' +
          'count here prices a matching typed pull. Omit for no filter.',
      ),
    granularity: z
      .enum(['minute', 'hour', 'day'])
      .default('day')
      .describe('Time-bucket size for the series (default: day).'),
    start_time: z
      .string()
      .optional()
      .describe('Oldest timestamp, ISO 8601 (recent scope: within the last 7 days).'),
    end_time: z.string().optional().describe('Newest timestamp, ISO 8601.'),
  }),
  output: z.object({
    query: z.string(),
    total: z.number(),
    granularity: z.string(),
    buckets: z.array(
      z.object({
        start: z.string().nullable(),
        end: z.string().nullable(),
        count: z.number(),
      }),
    ),
    note: z.string(),
  }),
  async handler(args, ctx) {
    const query = applyPostTypes(args.query, args.post_types);
    ctx.log('count_posts', {
      query,
      scope: args.scope,
      granularity: args.granularity,
    });
    const params = new URLSearchParams({
      query,
      granularity: args.granularity,
    });
    if (args.start_time) params.set('start_time', args.start_time);
    if (args.end_time) params.set('end_time', args.end_time);

    const path = args.scope === 'archive' ? '/2/tweets/counts/all' : '/2/tweets/counts/recent';
    const body = await xGet(path, params, ctx);
    const rawBuckets = Array.isArray(body.data) ? body.data : [];
    const buckets = rawBuckets.map((b) => {
      const o = b as Record<string, unknown>;
      return {
        start: strOrNull(o.start),
        end: strOrNull(o.end),
        count: numOrNull(o.tweet_count) ?? 0,
      };
    });
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    const total = numOrNull(meta.total_tweet_count) ?? buckets.reduce((sum, b) => sum + b.count, 0);
    const estPull = (total * POST_READ_USD).toFixed(3);
    const countFee = args.scope === 'archive' ? 0.01 : 0.005;
    const countLabel = args.scope === 'archive' ? 'Counts: All' : 'Counts: Recent';
    // Describe the window honestly: an explicit date range, else the scope default.
    const windowLabel =
      args.start_time || args.end_time
        ? `between ${args.start_time ?? 'the start'} and ${args.end_time ?? 'now'}`
        : args.scope === 'archive'
          ? 'across the full archive'
          : 'in the last 7 days';
    const note =
      `${countLabel} — a flat $${countFee.toFixed(3)} per request (the count itself ` +
      `is not billed per result). Reading these ${total} posts would cost ≈ ` +
      `$${estPull} ($0.005/post).`;
    return {
      text:
        `"${query}" — ${total} post(s) ${windowLabel}. ` +
        `Reading them all would cost ≈ $${estPull}.\n${note}`,
      structured: {
        query,
        total,
        granularity: args.granularity,
        buckets,
        note,
      },
    };
  },
};
