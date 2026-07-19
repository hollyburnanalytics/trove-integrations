import { type ToolDefinition, z } from '@ontrove/mcp';
import { searchReview } from '../worksafebc.ts';

/**
 * `search_review_decisions` — keyword search over the WorkSafeBC Review Division.
 */
export const searchReviewDecisions: ToolDefinition = {
  name: 'search_review_decisions',
  title: 'WorkSafeBC Review Division: Search decisions',
  description:
    "Search the WorkSafeBC Review Division's published decisions (2013–present) by " +
    'keyword or phrase (quote a phrase, e.g. \'"scaphoid fracture"\'). Newest first. ' +
    "Returns the review reference number, date, and WorkSafeBC's result snippet. " +
    'WorkSafeBC caps a query at 1000 results — narrow the keyword if `truncated` is true.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    keyword: z.string().min(1).describe('Search keyword or quoted phrase.'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max decisions to return.'),
  }),
  output: z.object({
    keyword: z.string(),
    count: z.number(),
    total: z.number().nullable(),
    truncated: z.boolean(),
    decisions: z.array(
      z.object({
        number: z.string(),
        date: z.string().nullable(),
        snippet: z.string().nullable(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { keyword, limit } = args;
    ctx.log('search_review_decisions', { keyword, limit });
    const { decisions, total, truncated } = await searchReview(keyword, limit, ctx);

    if (decisions.length === 0) {
      return {
        text: `No WorkSafeBC Review decisions matched "${keyword}".`,
        structured: { keyword, count: 0, total, truncated, decisions: [] },
      };
    }
    const lines = decisions
      .map((d) => `  ${d.number} (${d.date ? d.date.slice(0, 10) : '?'}): ${d.snippet ?? ''}`)
      .join('\n');
    const note = truncated ? ` (of ${total}+ — narrow the keyword to reach older matches)` : '';
    return {
      text: `${decisions.length} WorkSafeBC Review decision(s)${note}:\n${lines}`,
      structured: { keyword, count: decisions.length, total, truncated, decisions },
    };
  },
};
