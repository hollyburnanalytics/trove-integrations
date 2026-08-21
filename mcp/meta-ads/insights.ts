import { type ToolContext, ToolError } from '@ontrove/extend/toolkit';
import { graphGet, objectId, type Paging, type RateLimitReading, readPaging } from './client.ts';
import type { Level } from './fields.ts';
import { type InsightRow, mapRow } from './rows.ts';

/**
 * Building one insights request and reading the answer back.
 *
 * Shared by `get_insights` and `compare_periods` so the two cannot drift: a
 * comparison whose two halves were built by different code is a comparison of
 * nothing.
 *
 * The validation here exists because Meta accepts far more than it honours. A
 * `time_range` sent alongside a `date_preset` silently wins; a range whose start
 * is older than 37 months is answered with an error that names neither bound;
 * and a reversed range comes back as an empty 200, which reads exactly like "no
 * spend in that window".
 */

/** How rows are cut up in time. */
export const TIME_INCREMENTS = ['all_days', 'daily', 'weekly', 'monthly'] as const;
export type TimeIncrement = (typeof TIME_INCREMENTS)[number];

/** Meta's own spelling of each increment. */
const INCREMENT_PARAM: Record<TimeIncrement, string> = {
  all_days: 'all_days',
  daily: '1',
  weekly: '7',
  monthly: 'monthly',
};

/** Metrics a caller may sort on (Meta sorts on the metric, not the label). */
export const SORTABLE = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'reach'] as const;
export type Sortable = (typeof SORTABLE)[number];

/** One fully-specified insights query. */
export interface InsightsQuery {
  accountId: string;
  level: Level;
  fields: readonly string[];
  datePreset?: string;
  since?: string;
  until?: string;
  timeIncrement: TimeIncrement;
  breakdowns: readonly string[];
  attributionWindows?: readonly string[];
  useUnifiedAttribution: boolean;
  actionReportTime?: string;
  campaignIds?: readonly string[];
  adsetIds?: readonly string[];
  adIds?: readonly string[];
  sortBy?: Sortable;
  sortDirection: 'asc' | 'desc';
  limit: number;
  after?: string;
  includeTotals: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Parse a `YYYY-MM-DD` bound, or say precisely which one is wrong. */
function parseDay(value: string, field: string): number {
  if (!ISO_DAY.test(value)) {
    throw new ToolError(`${field}: expected a YYYY-MM-DD date, got "${value}".`, {
      retryable: false,
    });
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    throw new ToolError(`${field}: "${value}" is not a real date.`, { retryable: false });
  }
  return parsed;
}

/** The window a query covers, validated. Returns the day count for sizing. */
function validateWindow(query: InsightsQuery, now: Date): number | undefined {
  const { since, until, datePreset } = query;
  if (datePreset && (since || until)) {
    throw new ToolError(
      'Give either date_preset or since/until, not both — Meta silently ignores the preset ' +
        'when an explicit range is present, so the answer would not be the window you asked for.',
      { retryable: false },
    );
  }
  if (!since !== !until) {
    throw new ToolError('since and until go together — give both, or neither.', {
      retryable: false,
    });
  }
  if (!since || !until) return undefined;

  const from = parseDay(since, 'since');
  const to = parseDay(until, 'until');
  if (from > to) {
    throw new ToolError(
      `since (${since}) is after until (${until}). A reversed range cannot match anything, and ` +
        'an empty result reads as "no spend" rather than as a mistake.',
      { retryable: false },
    );
  }
  // Meta serves roughly 37 months of insights and refuses older starts with
  // code 3018 — worth naming before spending the call.
  const monthsBack = (now.getTime() - from) / (DAY_MS * 30.44);
  if (monthsBack > 37) {
    throw new ToolError(
      `since (${since}) is more than 37 months ago, which is as far back as Meta serves ads ` +
        'insights. Move the start forward.',
      { retryable: false },
    );
  }
  return Math.round((to - from) / DAY_MS) + 1;
}

/** A `filtering` clause, as Graph takes them. */
interface Filter {
  field: string;
  operator: string;
  value: string[];
}

/**
 * Where to ask, and what to filter by, for the ids a caller narrowed to.
 *
 * One id, one kind → its OWN insights edge (`/{campaign_id}/insights`), which
 * is documented on the campaign, ad set and ad objects alike and takes the same
 * 23 parameters as the account edge. That is the common case — "how did this
 * campaign do" — and routing it through a documented parent edge rather than a
 * `filtering` clause on `campaign.id` keeps the most-used path on the
 * best-attested ground.
 *
 * Anything else — several ids, or two kinds at once — still goes to the account
 * edge with `filtering`, which is the only way to express it.
 */
function narrowing(query: InsightsQuery): { path: string; filters: Filter[] } {
  const lists: [readonly string[] | undefined, string, string][] = [
    [query.adIds, 'ad.id', 'ad_ids'],
    [query.adsetIds, 'adset.id', 'adset_ids'],
    [query.campaignIds, 'campaign.id', 'campaign_ids'],
  ];
  const present = lists
    .filter(([ids]) => ids !== undefined && ids.length > 0)
    .map(([ids, field, argument]) => [
      (ids ?? []).map((id) => objectId(id, argument)),
      field,
      argument,
    ]) as [string[], string, string][];
  const only = present.length === 1 ? present[0] : undefined;
  const single = only?.[0]?.length === 1 ? only[0][0] : undefined;
  if (single !== undefined) return { path: `/${single}/insights`, filters: [] };
  return {
    path: `/${query.accountId}/insights`,
    filters: present.map(([ids, field]) => ({ field, operator: 'IN', value: ids })),
  };
}

/**
 * Build the query string for one insights call.
 *
 * List-valued parameters go over the wire as JSON (`filtering`, `sort`,
 * `time_range`) or as comma lists (`fields`, `breakdowns`), which is the split
 * Graph itself documents; mixing them up is another silently-ignored parameter.
 */
export function insightsParams(query: InsightsQuery, now: Date): URLSearchParams {
  validateWindow(query, now);
  const params = new URLSearchParams({
    level: query.level,
    fields: query.fields.join(','),
    limit: String(query.limit),
    time_increment: INCREMENT_PARAM[query.timeIncrement],
  });
  if (query.since && query.until) {
    params.set('time_range', JSON.stringify({ since: query.since, until: query.until }));
  } else {
    params.set('date_preset', query.datePreset ?? 'last_30d');
  }
  if (query.breakdowns.length > 0) params.set('breakdowns', query.breakdowns.join(','));
  if (query.attributionWindows && query.attributionWindows.length > 0) {
    params.set('action_attribution_windows', query.attributionWindows.join(','));
  } else if (query.useUnifiedAttribution) {
    // Without this, Meta reports on the API's default window rather than the
    // one the ad set actually optimises for — so the tool's conversion counts
    // disagree with Ads Manager for the same campaign, same dates.
    params.set('use_unified_attribution_setting', 'true');
  }
  const { filters } = narrowing(query);
  if (filters.length > 0) params.set('filtering', JSON.stringify(filters));
  // Meta dates a conversion by the IMPRESSION that earned it by default, so a
  // purchase today can land on last week's row. Analytics tools usually count
  // it on the conversion date instead, and that difference is the usual reason
  // two dashboards disagree — so the choice is exposed rather than assumed.
  if (query.actionReportTime) params.set('action_report_time', query.actionReportTime);
  if (query.sortBy) {
    params.set(
      'sort',
      JSON.stringify([
        `${query.sortBy}_${query.sortDirection === 'asc' ? 'ascending' : 'descending'}`,
      ]),
    );
  }
  if (query.after) params.set('after', query.after);
  // Meta's `summary` is totals across EVERY matching row, not just the page —
  // the only way a truncated answer can say what fraction of the spend it holds.
  if (query.includeTotals) params.set('summary', 'spend,impressions,clicks');
  return params;
}

/** The window a query covers in days, when it is an explicit range. */
export function windowDays(query: InsightsQuery, now: Date): number | undefined {
  return validateWindow(query, now);
}

/** What one insights call came back with. */
export interface InsightsResult {
  rows: InsightRow[];
  paging: Paging;
  rateLimit?: RateLimitReading;
  /** Meta's own totals across ALL matching rows, when `includeTotals` asked. */
  summary?: { spend?: number; impressions?: number; clicks?: number };
  /** True when Meta ignored the requested sort and the rows were ordered here. */
  sortedLocally: boolean;
  /**
   * The ad account the rows actually came from, when it is not the one asked
   * for — which a single-entity query can do: an id belonging to another
   * account this token reaches answers from THAT account.
   */
  reportedAccountId?: string;
}

/** Read the `summary` envelope Meta returns when asked for account-wide totals. */
function readSummary(body: Record<string, unknown>): InsightsResult['summary'] {
  const raw = body.summary;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    spend: toNumber(record.spend),
    impressions: toNumber(record.impressions),
    clicks: toNumber(record.clicks),
  };
}

/**
 * Order the page the way the caller asked, if Meta did not.
 *
 * `sort` is a documented parameter, but nothing in the response says whether it
 * was applied — and a silently unsorted "top spenders" list is worse than an
 * unsorted one, because it looks ranked. So the returned order is CHECKED
 * rather than trusted, and when it does not match the request the rows are
 * sorted here — which the caller is told, because sorting a page is not the
 * same promise as sorting the result set.
 */
function enforceSort(rows: InsightRow[], query: InsightsQuery): boolean {
  if (!query.sortBy || rows.length < 2) return false;
  const key = query.sortBy;
  const sign = query.sortDirection === 'asc' ? 1 : -1;
  const value = (row: InsightRow): number => row.metrics[key] ?? 0;
  const ordered = rows.every(
    (row, index) => index === 0 || sign * (value(row) - value(rows[index - 1] as InsightRow)) >= 0,
  );
  if (ordered) return false;
  rows.sort((a, b) => sign * (value(a) - value(b)));
  return true;
}

/** Run one insights query and map the answer. */
export async function fetchInsights(
  ctx: ToolContext,
  query: InsightsQuery,
): Promise<InsightsResult> {
  const params = insightsParams(query, ctx.now());
  const { body, rateLimit } = await graphGet(ctx, narrowing(query).path, params);
  const raw = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  const rows = raw.map((row) => mapRow(row, query.level, query.breakdowns));
  const sortedLocally = enforceSort(rows, query);
  // An entity id is not scoped to the account that was resolved for it, so a
  // campaign belonging to another reachable account answers from there. The
  // rows say whose they are; labelling them with the account we assumed would
  // be a quiet lie.
  const reported = rows.find((row) => row.accountId !== undefined)?.accountId;
  const reportedAccountId =
    reported !== undefined && `act_${reported}` !== query.accountId ? `act_${reported}` : undefined;
  return {
    rows,
    paging: readPaging(body),
    rateLimit,
    summary: readSummary(body),
    sortedLocally,
    reportedAccountId,
  };
}
