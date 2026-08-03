import { type ToolDefinition, z } from '@ontrove/mcp';
import { getQuota, quotaOutput } from '../discover.ts';

/**
 * `check_quota` — the account's remaining monthly requests and transcript credits.
 */
export const checkQuotaTool: ToolDefinition = {
  name: 'check_quota',
  title: 'Taddy: Check remaining quota',
  description:
    'How many API requests and transcript credits the Taddy account has left this month. ' +
    'Taddy meters by the month (the free tier is 500 requests), so check this before a run of ' +
    'searches, or when a call fails with a quota error.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({}),
  output: quotaOutput,
  async handler(_args, ctx) {
    ctx.log('check_quota');
    const result = await getQuota(ctx);
    const requests = result.apiRequestsRemaining;
    const credits = result.transcriptCreditsRemaining;
    return {
      text:
        `API requests remaining this month: ${requests === null ? 'unknown' : String(requests)}\n` +
        `Transcript credits remaining: ${credits === null ? 'unknown' : String(credits)}` +
        (credits === 0
          ? '\nWith no credits left, get_transcript can still return transcripts the podcast supplies itself, but not on-demand ones.'
          : ''),
      structured: result,
    };
  },
};
