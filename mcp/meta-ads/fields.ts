import { ToolError } from '@ontrove/extend/toolkit';

/**
 * What to ask Meta for, and what the answer means: metric presets, the identity
 * fields each reporting level needs, the enums the tools expose, and the money
 * helpers.
 *
 * Fields are grouped into PRESETS rather than left as free text because the
 * failure mode of a mis-typed field name is an error 100 that names the field
 * and costs a round trip — and because the useful sets are small and well known.
 * `extra_fields` remains the escape hatch for anything not listed.
 */

/** Metrics every level gets, whatever else was asked for. */
const CORE = [
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  // Cost per 1,000 PEOPLE reached, next to cpm's cost per 1,000 impressions.
  // The gap between the two is frequency, which is the whole story in an
  // audience the campaign has saturated.
  'cpp',
  'reach',
  'frequency',
] as const;

const ENGAGEMENT = [
  'inline_link_clicks',
  'inline_link_click_ctr',
  'cost_per_inline_link_click',
  'outbound_clicks',
  'outbound_clicks_ctr',
  'unique_clicks',
  'unique_ctr',
] as const;

const CONVERSIONS = [
  'actions',
  'action_values',
  'cost_per_action_type',
  'purchase_roas',
  'website_purchase_roas',
  // `conversions` is NOT a subset of `actions`: it counts the account's
  // configured custom conversions, which an account can define over events
  // that never appear as a standard action type.
  'conversions',
  'conversion_values',
  'cost_per_conversion',
] as const;

const VIDEO = [
  'video_play_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p100_watched_actions',
  'video_thruplay_watched_actions',
  'video_avg_time_watched_actions',
] as const;

/**
 * Ad-level only, and that is not a preference of ours: Meta computes the three
 * rankings per ad against its auction competitors, so above ad level there is
 * nothing to aggregate and the request is rejected rather than answered.
 */
const QUALITY = ['quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'] as const;

/** The metric groups a caller can ask for. */
export const METRIC_GROUPS = ['core', 'engagement', 'conversions', 'video', 'quality'] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];

const GROUPS: Record<MetricGroup, readonly string[]> = {
  core: CORE,
  engagement: ENGAGEMENT,
  conversions: CONVERSIONS,
  video: VIDEO,
  quality: QUALITY,
};

/** The reporting levels Meta aggregates to. */
export const LEVELS = ['account', 'campaign', 'adset', 'ad'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Identity fields per level — the names and ids that make a row mean something.
 *
 * A row without them is a bare pile of numbers: at `level: "campaign"` the API
 * will happily return spend and impressions and nothing saying WHICH campaign,
 * which is the same class of bug the world-bank toolkit shipped once.
 */
const IDENTITY: Record<Level, readonly string[]> = {
  account: ['account_id', 'account_name', 'account_currency'],
  campaign: ['account_id', 'account_currency', 'campaign_id', 'campaign_name', 'objective'],
  adset: [
    'account_id',
    'account_currency',
    'campaign_id',
    'campaign_name',
    'adset_id',
    'adset_name',
    'objective',
    'optimization_goal',
    'attribution_setting',
  ],
  ad: [
    'account_id',
    'account_currency',
    'campaign_id',
    'campaign_name',
    'adset_id',
    'adset_name',
    'ad_id',
    'ad_name',
    'objective',
    'optimization_goal',
    'attribution_setting',
  ],
};

/**
 * Build the `fields` list for one request.
 *
 * `quality` is refused above ad level by name rather than passed through: Meta
 * answers it with a parameter error that mentions neither the level nor which
 * of the requested fields caused it.
 */
export function fieldsFor(
  level: Level,
  groups: readonly MetricGroup[],
  extra: readonly string[] = [],
): string[] {
  if (groups.includes('quality') && level !== 'ad') {
    throw new ToolError(
      `The quality metrics (quality_ranking, engagement_rate_ranking, conversion_rate_ranking) ` +
        `exist per AD only — Meta ranks each ad against its auction competitors. Ask for them ` +
        `with level: "ad", or drop "quality" from metrics at level: "${level}".`,
      { retryable: false },
    );
  }
  const chosen = groups.flatMap((group) => GROUPS[group]);
  return [...new Set([...IDENTITY[level], 'date_start', 'date_stop', ...chosen, ...extra])];
}

/** The object types `list_entities` lists. */
export const ENTITY_LEVELS = ['campaign', 'adset', 'ad'] as const;
export type EntityLevel = (typeof ENTITY_LEVELS)[number];

/**
 * Delivery statuses, per level, exactly as Meta's enums define them.
 *
 * `effective_status` rather than `status`, because they differ in the case that
 * matters: an ACTIVE ad inside a paused campaign has `status: ACTIVE` and
 * `effective_status: CAMPAIGN_PAUSED`, and only the second one explains why it
 * is not spending.
 *
 * Per level, because the enums are NOT the same: a campaign has six values, an
 * ad set seven, an ad twelve. Review is an ad-level concept, so `DISAPPROVED`
 * and `PENDING_REVIEW` do not exist on the campaign edge — sending one there is
 * a rejected request, not an empty list. The tool advertises the union (so the
 * whole vocabulary is discoverable) and refuses the mismatch by name.
 */
export const STATUSES_BY_LEVEL = {
  campaign: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'],
  adset: [
    'ACTIVE',
    'PAUSED',
    'DELETED',
    'ARCHIVED',
    'CAMPAIGN_PAUSED',
    'IN_PROCESS',
    'WITH_ISSUES',
  ],
  ad: [
    'ACTIVE',
    'PAUSED',
    'DELETED',
    'ARCHIVED',
    'CAMPAIGN_PAUSED',
    'ADSET_PAUSED',
    'IN_PROCESS',
    'WITH_ISSUES',
    'PENDING_REVIEW',
    'DISAPPROVED',
    'PENDING_BILLING_INFO',
    'PREAPPROVED',
  ],
} as const satisfies Record<EntityLevel, readonly string[]>;

/** Every delivery status, for the input schema. Validity is per level. */
export const ENTITY_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'DELETED',
  'ARCHIVED',
  'CAMPAIGN_PAUSED',
  'ADSET_PAUSED',
  'IN_PROCESS',
  'WITH_ISSUES',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'PENDING_BILLING_INFO',
  'PREAPPROVED',
] as const;

/**
 * Refuse a status the requested level does not have, naming the ones it does.
 *
 * Meta answers an out-of-enum value with a parameter error that does not
 * mention the level, so "DISAPPROVED is an ad-level status" is knowledge the
 * caller has to already have.
 */
export function checkStatuses(level: EntityLevel, requested: readonly string[]): void {
  const allowed: readonly string[] = STATUSES_BY_LEVEL[level];
  const wrong = requested.filter((status) => !allowed.includes(status));
  if (wrong.length === 0) return;
  throw new ToolError(
    `${wrong.join(', ')} ${wrong.length === 1 ? 'is not a' : 'are not'} ${level} status. ` +
      `A ${level} can be: ${allowed.join(', ')}.` +
      (level === 'campaign' || level === 'adset'
        ? ' Review statuses (PENDING_REVIEW, DISAPPROVED, PREAPPROVED) exist per ad — ask at level: "ad".'
        : ''),
    { retryable: false },
  );
}

/**
 * What to read about each object type.
 *
 * Deliberately shallow — no `targeting`, no `creative{…}` expansion. Those are
 * large nested objects that would dominate a listing whose job is to say what
 * exists, what state it is in, and what it may spend.
 *
 * `account_id` is on every level for one reason: budgets come back in the
 * account currency's minimum unit with no currency attached, and a parent edge
 * (`/{campaign_id}/adsets`) can reach a campaign in a DIFFERENT account from
 * the one resolved for the call. Without this, a ¥5,000/day budget over there
 * prints as USD 50.00 over here.
 */
export const ENTITY_FIELDS: Record<EntityLevel, string> = {
  campaign:
    'id,name,account_id,status,effective_status,objective,buying_type,bid_strategy,daily_budget,' +
    'lifetime_budget,budget_remaining,start_time,stop_time,updated_time',
  adset:
    'id,name,account_id,status,effective_status,campaign_id,optimization_goal,billing_event,' +
    'bid_amount,bid_strategy,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,' +
    'updated_time',
  ad: 'id,name,account_id,status,effective_status,adset_id,campaign_id,created_time,updated_time',
};

/**
 * What to read about an ad account: enough to pick one and to explain an empty
 * report (a non-ACTIVE status is the usual reason) without a second call.
 */
export const ACCOUNT_FIELDS = 'account_id,name,currency,timezone_name,account_status,amount_spent';

/** Meta's named windows, verbatim — the cheapest ranges to query. */
export const DATE_PRESETS = [
  'today',
  'yesterday',
  'this_week_mon_today',
  'this_week_sun_today',
  'last_week_mon_sun',
  'last_week_sun_sat',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'last_3d',
  'last_7d',
  'last_14d',
  'last_28d',
  'last_30d',
  'last_90d',
  // `maximum` is as far back as the API serves (37 months); `data_maximum` is
  // as far back as THIS account has data. They differ for a young account.
  'maximum',
  'data_maximum',
] as const;

/**
 * The breakdowns worth exposing — the ones that answer "who, where, on what".
 *
 * A deliberate subset of Meta's ~90: the rest are asset-level, SKAdNetwork or
 * catalogue dimensions that are meaningless without the matching campaign type,
 * and several (product_id, action_target_id) explode row counts far past what a
 * tool call can return. `extra_breakdowns` is the escape hatch.
 */
export const BREAKDOWNS = [
  'age',
  'gender',
  'country',
  'region',
  'dma',
  'publisher_platform',
  'platform_position',
  'impression_device',
  'device_platform',
  'hourly_stats_aggregated_by_advertiser_time_zone',
  'frequency_value',
] as const;

/**
 * Attribution windows, as Meta spells them.
 *
 * Which ones an account can actually use depends on its own attribution
 * setting, so an unavailable window is a Meta-side rejection rather than
 * something checkable here. Left unset, `use_unified_attribution_setting`
 * governs and the numbers match Ads Manager.
 */
export const ATTRIBUTION_WINDOWS = [
  '1d_view',
  '7d_view',
  '28d_view',
  '1d_click',
  '7d_click',
  '28d_click',
  'dda',
  'default',
] as const;

/**
 * Currencies Meta reports in whole units rather than hundredths.
 *
 * Budgets (unlike `spend`) come back in the account currency's minimum unit, so
 * a ¥5,000 daily budget and a $50.00 one are both the string "5000". Dividing
 * every currency by 100 would report the yen budget as ¥50. The raw minor-unit
 * value always rides along in the structured result, so a currency missing from
 * this list is recoverable rather than silently wrong.
 */
const WHOLE_UNIT_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'TWD']);

/** Convert a Meta minor-unit money string into major units of `currency`. */
export function fromMinorUnits(raw: unknown, currency: string | undefined): number | undefined {
  const value = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return undefined;
  return WHOLE_UNIT_CURRENCIES.has((currency ?? '').toUpperCase()) ? value : value / 100;
}

/** Group a number with thousands separators, fixed to `decimals` places. */
export function group(value: number, decimals = 0): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole = '0', fraction] = fixed.split('.');
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Format money in the account's currency.
 *
 * The currency CODE is printed, never a bare `$`: an account can bill in any of
 * Meta's currencies, and a Canadian advertiser reading "$1,204" as USD is a
 * 40% error in the only number they care about.
 */
export function money(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) return 'n/a';
  return `${currency ? `${currency} ` : ''}${group(value, 2)}`;
}
