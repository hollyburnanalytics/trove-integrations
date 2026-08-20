import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { resolveAccountId } from '../client.ts';
import {
  baselineWindow,
  COMPARE_MODES,
  comparePairs,
  comparisonLine,
  comparisonShape,
  delta,
  deltaShape,
} from '../compare.ts';
import { fieldsFor, LEVELS } from '../fields.ts';
import { fetchInsights, type InsightsQuery } from '../insights.ts';
import { rateLimitNote } from '../notes.ts';
import { totalsOf } from '../rows.ts';

/** How many compared entities the prose mirror spells out. */
const PROSE_ROWS = 25;

/**
 * `compare_periods` — the same account, two windows, and what actually moved.
 *
 * Two insights calls with IDENTICAL shape (same level, same fields, same
 * attribution), differing only in `time_range`, then joined by entity id. Doing
 * it as one tool rather than asking the caller to make two calls and subtract
 * is not convenience: it guarantees the two halves were measured the same way,
 * and it keeps the entities that exist in only one window from being read as
 * zeroes.
 */
/**
 * The footer for a comparison: the three ways it can mislead, stated plainly.
 *
 * Split out of the handler because a comparison's caveats are the part most
 * likely to grow, and they are worth reading as one list rather than as a
 * ternary chain buried in the middle of a tool.
 */
function comparisonNotes(input: {
  truncated: boolean;
  limit: number;
  calendarYear: boolean;
  hasOneSided: boolean;
  rateLimit: Parameters<typeof rateLimitNote>[0];
}): string[] {
  return [
    input.truncated
      ? `TRUNCATED: one or both windows returned a full page of ${input.limit} row(s) with more ` +
        'behind it, so this compares the top spenders only — the totals below are of the rows ' +
        'shown, not of the account. Raise limit or narrow with campaign_ids.'
      : undefined,
    input.calendarYear
      ? 'previous_year uses the same calendar dates, so the two windows do not contain the same ' +
        'weekdays — expect a weekday-mix effect in the deltas.'
      : undefined,
    input.hasOneSided
      ? 'NEW = delivered only in the current window; STOPPED = delivered only in the baseline. ' +
        'Neither is a 100% change, and neither is included in a percentage.'
      : undefined,
    rateLimitNote(input.rateLimit),
  ].filter((note): note is string => note !== undefined);
}

export const comparePeriods = tool({
  name: 'compare_periods',
  title: 'Meta Ads: Compare two periods',
  description:
    'Compare Meta ad performance between two windows and rank what moved: spend, clicks, CTR, ' +
    'purchases and ROAS before vs after, per campaign, ad set, ad or for the whole account. ' +
    'Give the current window as since/until; the baseline is either the equal-length period ' +
    'immediately before it (previous_period) or the same dates a year earlier ' +
    '(previous_year), or set baseline_since/baseline_until explicitly. Entities present in ' +
    'only one window are flagged NEW or STOPPED rather than compared against a zero. Rows are ' +
    'ordered by the size of the spend move, so the biggest changes come first.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    ad_account_id: z
      .string()
      .optional()
      .describe('Ad account, act_1234567890 or the bare digits. Defaults to the saved setting.'),
    level: z
      .enum(LEVELS)
      .default('campaign')
      .describe('What to compare: account/campaign/adset/ad.'),
    since: z.string().describe('Current window start, YYYY-MM-DD inclusive.'),
    until: z.string().describe('Current window end, YYYY-MM-DD inclusive.'),
    compare_to: z
      .enum(COMPARE_MODES)
      .default('previous_period')
      .describe(
        'previous_period = the equal-length window immediately before; previous_year = the ' +
          'same calendar dates a year earlier (weekdays will not align).',
      ),
    baseline_since: z
      .string()
      .optional()
      .describe('Explicit baseline start, overriding compare_to. Needs baseline_until.'),
    baseline_until: z
      .string()
      .optional()
      .describe('Explicit baseline end, overriding compare_to. Needs baseline_since.'),
    campaign_ids: z.array(z.string()).optional().describe('Only these campaign ids.'),
    adset_ids: z.array(z.string()).optional().describe('Only these ad set ids.'),
    ad_ids: z.array(z.string()).optional().describe('Only these ad ids.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(25)
      .describe('Top-spending rows to fetch per window (1–500).'),
  }),
  output: z.object({
    accountId: z.string(),
    level: z.string(),
    current: z.object({ since: z.string(), until: z.string() }),
    baseline: z.object({ since: z.string(), until: z.string() }),
    count: z.number(),
    rows: z.array(comparisonShape),
    totals: z.object({
      spend: deltaShape,
      impressions: deltaShape,
      clicks: deltaShape,
      ctr: deltaShape,
      purchases: deltaShape,
      purchaseValue: deltaShape,
      currency: z.string().optional(),
    }),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  async handler(args, ctx) {
    const accountId = resolveAccountId(ctx, args.ad_account_id);
    if (!args.baseline_since !== !args.baseline_until) {
      throw new ToolError(
        'baseline_since and baseline_until go together — give both, or neither.',
        { retryable: false },
      );
    }
    const baseline =
      args.baseline_since && args.baseline_until
        ? { since: args.baseline_since, until: args.baseline_until }
        : baselineWindow(args.since, args.until, args.compare_to);

    const fields = fieldsFor(args.level, ['core', 'conversions']);
    const shared: Omit<InsightsQuery, 'since' | 'until'> = {
      accountId,
      level: args.level,
      fields,
      timeIncrement: 'all_days',
      breakdowns: [],
      useUnifiedAttribution: true,
      campaignIds: args.campaign_ids,
      adsetIds: args.adset_ids,
      adIds: args.ad_ids,
      // Both windows are pulled top-spend-first so that, if either is
      // truncated, the two pages are at least drawn from the same end of the
      // account rather than from arbitrary ones.
      sortBy: 'spend',
      sortDirection: 'desc',
      limit: args.limit,
      includeTotals: false,
    };
    ctx.log('compare_periods', { accountId, level: args.level, baseline });

    const current = await fetchInsights(ctx, {
      ...shared,
      since: args.since,
      until: args.until,
    });
    const previous = await fetchInsights(ctx, {
      ...shared,
      since: baseline.since,
      until: baseline.until,
    });

    const rows = comparePairs(previous.rows, current.rows);
    const currentTotals = totalsOf(current.rows);
    const previousTotals = totalsOf(previous.rows);
    const totals = {
      spend: delta(previousTotals.spend, currentTotals.spend),
      impressions: delta(previousTotals.impressions, currentTotals.impressions),
      clicks: delta(previousTotals.clicks, currentTotals.clicks),
      ctr: delta(previousTotals.ctr, currentTotals.ctr),
      purchases: delta(previousTotals.purchases, currentTotals.purchases),
      purchaseValue: delta(previousTotals.purchaseValue, currentTotals.purchaseValue),
      currency: currentTotals.currency ?? previousTotals.currency,
    };

    const truncated = current.paging.hasMore || previous.paging.hasMore;
    const notes = comparisonNotes({
      truncated,
      limit: args.limit,
      calendarYear: args.compare_to === 'previous_year' && !args.baseline_since,
      hasOneSided: rows.some((row) => row.presence !== 'both'),
      rateLimit: current.rateLimit ?? previous.rateLimit,
    });

    const window = `${args.since}→${args.until} vs ${baseline.since}→${baseline.until}`;
    if (rows.length === 0) {
      const empty = `No ${args.level} delivery in either window (${window}).`;
      return {
        text: [empty, ...notes].join('\n'),
        structured: {
          accountId,
          level: args.level,
          current: { since: args.since, until: args.until },
          baseline,
          count: 0,
          rows: [],
          totals,
          truncated,
          notes: [empty, ...notes],
        },
      };
    }

    const lines = rows.slice(0, PROSE_ROWS).map((row) => comparisonLine(row));
    const hidden = rows.length - lines.length;
    const totalLine =
      `Totals across the rows shown: spend ${totals.spend.before?.toFixed(2) ?? '—'} → ` +
      `${totals.spend.after?.toFixed(2) ?? '—'} ${totals.currency ?? ''}` +
      (totals.spend.changePct === undefined
        ? ''
        : ` (${totals.spend.changePct >= 0 ? '+' : ''}${totals.spend.changePct.toFixed(1)}%)`);

    return {
      text: [
        `${rows.length} ${args.level}(s), ${window}:`,
        ...lines,
        hidden > 0 ? `… ${hidden} more in the structured result.` : undefined,
        totalLine,
        ...notes,
      ]
        .filter(Boolean)
        .join('\n'),
      structured: {
        accountId,
        level: args.level,
        current: { since: args.since, until: args.until },
        baseline,
        count: rows.length,
        rows,
        totals,
        truncated,
        notes,
      },
    };
  },
});
