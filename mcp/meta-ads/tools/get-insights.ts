import { tool, z } from '@ontrove/extend/toolkit';
import { resolveAccountId } from '../client.ts';
import {
  ATTRIBUTION_WINDOWS,
  BREAKDOWNS,
  DATE_PRESETS,
  fieldsFor,
  LEVELS,
  METRIC_GROUPS,
} from '../fields.ts';
import { fetchInsights, SORTABLE, TIME_INCREMENTS } from '../insights.ts';
import {
  coverageNote,
  emptyNote,
  granularityNote,
  rateLimitNote,
  truncationNote,
  windowLabel,
} from '../notes.ts';
import { insightRowShape, rowLine, totalsLine, totalsOf } from '../rows.ts';

/** How many rows the prose mirror spells out before deferring to the payload. */
const PROSE_ROWS = 40;

/**
 * `get_insights` — the workhorse: spend and performance for an ad account,
 * aggregated to account, campaign, ad set or ad, over a window, optionally cut
 * by time and by audience/placement breakdowns.
 */
export const getInsights = tool({
  name: 'get_insights',
  title: 'Meta Ads: Performance insights',
  description:
    'Ad performance from the Meta Marketing API: spend, impressions, clicks, CTR, CPC, CPM, ' +
    'reach and attributed conversions (purchases, leads, ROAS) for one ad account, aggregated ' +
    'at account, campaign, adset or ad level. Pick a window with date_preset (last_7d, ' +
    'last_30d, this_month…) or an explicit since/until; set time_increment to daily/weekly/' +
    'monthly for a time series instead of one total row; add breakdowns (age, gender, country, ' +
    'publisher_platform, platform_position, device…) to cut the same numbers by audience or ' +
    'placement. Narrow to specific campaigns/ad sets/ads by id. Conversion counts follow the ' +
    "ad set's own attribution setting by default, so they match Ads Manager. Rows come back " +
    'ONLY for entities that delivered in the window — a paused campaign is absent, not zero.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    ad_account_id: z
      .string()
      .optional()
      .describe('Ad account, act_1234567890 or the bare digits. Defaults to the saved setting.'),
    level: z
      .enum(LEVELS)
      .default('campaign')
      .describe('Aggregation level: account (one row), campaign, adset or ad.'),
    date_preset: z
      .enum(DATE_PRESETS)
      .optional()
      .describe('Named window (default last_30d). Mutually exclusive with since/until.'),
    since: z.string().optional().describe('Range start, YYYY-MM-DD inclusive. Needs until.'),
    until: z.string().optional().describe('Range end, YYYY-MM-DD inclusive. Needs since.'),
    time_increment: z
      .enum(TIME_INCREMENTS)
      .default('all_days')
      .describe('all_days = one row per entity; daily/weekly/monthly = a time series.'),
    metrics: z
      .array(z.enum(METRIC_GROUPS))
      .default(['core', 'conversions'])
      .describe(
        'Metric groups: core (spend/impressions/clicks/CTR/CPC/CPM/reach/frequency), ' +
          'engagement (link clicks, outbound clicks, unique clicks), conversions (actions, ' +
          'values, cost per action, ROAS), video (play + 25/50/75/100% + ThruPlay), ' +
          'quality (the three ad-level auction rankings; level "ad" only).',
      ),
    extra_fields: z
      .array(z.string())
      .optional()
      .describe('Additional raw AdsInsights field names to request verbatim.'),
    breakdowns: z
      .array(z.enum(BREAKDOWNS))
      .optional()
      .describe(
        'Cut each row by these dimensions. Not all combine — Meta rejects unsupported pairs.',
      ),
    attribution_windows: z
      .array(z.enum(ATTRIBUTION_WINDOWS))
      .optional()
      .describe(
        "Report conversions on these windows instead of the ad set's own setting (e.g. " +
          '["1d_click","7d_click"]). Leave unset to match Ads Manager.',
      ),
    action_report_time: z
      .enum(['impression', 'conversion', 'mixed'])
      .optional()
      .describe(
        "Which date a conversion is counted on: impression (Meta's default — the day the ad " +
          'was seen), conversion (the day it happened, as most analytics tools count), or ' +
          'mixed (clicks by impression time, conversions by conversion time).',
      ),
    campaign_ids: z
      .array(z.string())
      .optional()
      .describe("Only these campaign ids. A single id is read from the campaign's own edge."),
    adset_ids: z.array(z.string()).optional().describe('Only these ad set ids.'),
    ad_ids: z.array(z.string()).optional().describe('Only these ad ids.'),
    sort_by: z
      .enum(SORTABLE)
      .optional()
      .describe('Ask Meta to order rows by this metric (spend, impressions, clicks, ctr…).'),
    sort_direction: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
    limit: z.number().int().min(1).max(500).default(25).describe('Rows per page (1–500).'),
    after: z.string().optional().describe("Cursor from a previous call's next_cursor."),
    include_totals: z
      .boolean()
      .default(false)
      .describe(
        'Also ask Meta for spend/impressions/clicks totalled across ALL matching rows, so a ' +
          'truncated answer can say what share of the account it holds.',
      ),
  }),
  output: z.object({
    accountId: z.string(),
    level: z.string(),
    window: z.string(),
    count: z.number(),
    rows: z.array(insightRowShape),
    totals: z.object({
      spend: z.number(),
      impressions: z.number(),
      clicks: z.number(),
      ctr: z.number().optional(),
      cpc: z.number().optional(),
      cpm: z.number().optional(),
      purchases: z.number().optional(),
      purchaseValue: z.number().optional(),
      currency: z.string().optional(),
    }),
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
    allRowsSummary: z
      .object({
        spend: z.number().optional(),
        impressions: z.number().optional(),
        clicks: z.number().optional(),
      })
      .optional(),
    sortedLocally: z.boolean(),
    notes: z.array(z.string()),
  }),
  async handler(args, ctx) {
    const accountId = resolveAccountId(ctx, args.ad_account_id);
    const breakdowns = args.breakdowns ?? [];
    const fields = fieldsFor(args.level, args.metrics, args.extra_fields ?? []);
    ctx.log('get_insights', { accountId, level: args.level, breakdowns: breakdowns.length });

    const result = await fetchInsights(ctx, {
      accountId,
      level: args.level,
      fields,
      datePreset: args.date_preset,
      since: args.since,
      until: args.until,
      timeIncrement: args.time_increment,
      breakdowns,
      attributionWindows: args.attribution_windows,
      useUnifiedAttribution: true,
      actionReportTime: args.action_report_time,
      campaignIds: args.campaign_ids,
      adsetIds: args.adset_ids,
      adIds: args.ad_ids,
      sortBy: args.sort_by,
      sortDirection: args.sort_direction,
      limit: args.limit,
      after: args.after,
      includeTotals: args.include_totals,
    });

    const window = windowLabel(args.date_preset, args.since, args.until);
    const totals = totalsOf(result.rows);
    const notes = [
      truncationNote(result.rows.length, result.paging.hasMore, result.paging.after),
      coverageNote(totals, result.summary),
      granularityNote(args.level, args.time_increment, breakdowns.length),
      result.sortedLocally
        ? `Meta did not honour sort_by "${args.sort_by}", so these ${result.rows.length} row(s) ` +
          'were ordered here — the ordering covers this page only, not the whole result set.'
        : undefined,
      args.attribution_windows?.length
        ? `Conversions are reported on ${args.attribution_windows.join(', ')}, which will differ ` +
          "from Ads Manager unless those match the ad set's own attribution setting."
        : undefined,
      args.action_report_time && args.action_report_time !== 'impression'
        ? `Conversions are dated by ${args.action_report_time} time, not by impression time — ` +
          'Ads Manager defaults to impression time, so totals will not line up with it.'
        : undefined,
      rateLimitNote(result.rateLimit),
    ].filter((note): note is string => note !== undefined);

    if (result.rows.length === 0) {
      const empty = emptyNote(args.level, window);
      return {
        text: [empty, ...notes].join('\n'),
        structured: {
          accountId,
          level: args.level,
          window,
          count: 0,
          rows: [],
          totals,
          truncated: false,
          sortedLocally: false,
          notes: [empty, ...notes],
        },
      };
    }

    const lines = result.rows.slice(0, PROSE_ROWS).map((row) => rowLine(row));
    const hidden = result.rows.length - lines.length;
    const text = [
      `${result.rows.length} ${args.level} row(s) for ${accountId} ${window}:`,
      ...lines,
      hidden > 0 ? `… ${hidden} more row(s) in the structured result.` : undefined,
      totalsLine(totals, result.rows.length),
      ...notes,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      text,
      structured: {
        accountId,
        level: args.level,
        window,
        count: result.rows.length,
        rows: result.rows,
        totals,
        truncated: result.paging.hasMore,
        nextCursor: result.paging.after,
        allRowsSummary: result.summary,
        sortedLocally: result.sortedLocally,
        notes,
      },
    };
  },
});
