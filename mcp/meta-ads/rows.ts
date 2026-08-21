import { z } from '@ontrove/extend/toolkit';
import { group, type Level, money } from './fields.ts';

/**
 * Turning one Graph insights row into something a reader can trust: typed
 * numbers, a label that says whose numbers these are, and totals computed the
 * only way that is arithmetically defensible.
 *
 * Two upstream facts drive everything here. **Every metric arrives as a
 * string** — `"spend": "1234.56"`, `"impressions": "98765"` — so a row handed
 * back unmapped sorts and sums as text. And **conversions arrive as lists**:
 * `actions` is `[{action_type, value}, …]` covering every action type the ad
 * drove, not a number, so "how many purchases" is a lookup rather than a field.
 */

/** A numeric-ish Graph value → number, else undefined. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One `{action_type, value}` entry, as Meta sends it. */
interface ActionEntry {
  action_type?: unknown;
  value?: unknown;
}

/**
 * Flatten an action list into `{action_type: value}`.
 *
 * Repeats are ADDED rather than overwritten. With the default
 * `action_breakdowns` an action type appears once, so this never fires today —
 * but the moment a list is broken down by anything else (device, destination),
 * the same action type appears once per slice, and last-one-wins would report
 * one slice as the whole. A total is the one answer that stays true under
 * either shape.
 */
function actionMap(raw: unknown): Record<string, number> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const entry of raw as ActionEntry[]) {
    const type = typeof entry?.action_type === 'string' ? entry.action_type : undefined;
    const value = num(entry?.value);
    if (type !== undefined && value !== undefined) out[type] = (out[type] ?? 0) + value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sum an action list into a single count (video milestones and the like). */
function actionTotal(raw: unknown): number | undefined {
  const map = actionMap(raw);
  if (!map) return undefined;
  return Object.values(map).reduce((sum, value) => sum + value, 0);
}

/** Fields that identify the row rather than measure it. */
const IDENTITY_KEYS = new Set([
  'account_id',
  'account_name',
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
  'date_start',
  'date_stop',
]);

/** Action lists that get their own named home on the row. */
const ACTION_KEYS = new Set(['actions', 'action_values', 'cost_per_action_type']);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** The Zod shape of a mapped row — the tools' `output` contract. */
export const insightRowShape = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  level: z.string(),
  accountId: z.string().optional(),
  accountName: z.string().optional(),
  campaignId: z.string().optional(),
  campaignName: z.string().optional(),
  adsetId: z.string().optional(),
  adsetName: z.string().optional(),
  adId: z.string().optional(),
  adName: z.string().optional(),
  objective: z.string().optional(),
  optimizationGoal: z.string().optional(),
  attributionSetting: z.string().optional(),
  currency: z.string().optional(),
  dateStart: z.string().optional(),
  dateStop: z.string().optional(),
  breakdowns: z.record(z.string(), z.string()).optional(),
  metrics: z.record(z.string(), z.number()),
  labels: z.record(z.string(), z.string()).optional(),
  actions: z.record(z.string(), z.number()).optional(),
  actionValues: z.record(z.string(), z.number()).optional(),
  costPerAction: z.record(z.string(), z.number()).optional(),
  purchaseRoas: z.number().optional(),
});

export type InsightRow = z.infer<typeof insightRowShape>;

/** The entity id + name for the level this row reports at. */
function identityFor(level: Level, raw: Record<string, unknown>): { id?: string; name?: string } {
  if (level === 'ad') return { id: str(raw.ad_id), name: str(raw.ad_name) };
  if (level === 'adset') return { id: str(raw.adset_id), name: str(raw.adset_name) };
  if (level === 'campaign') return { id: str(raw.campaign_id), name: str(raw.campaign_name) };
  return { id: str(raw.account_id), name: str(raw.account_name) };
}

/** The three buckets a non-identity field can land in. */
interface Buckets {
  metrics: Record<string, number>;
  labels: Record<string, string>;
  breakdowns: Record<string, string>;
}

/**
 * File one field of a raw row.
 *
 * Written as a fall-through rather than a list of known metric names, so a
 * field a caller asked for via `extra_fields` still arrives typed instead of
 * being dropped for not appearing on a list maintained here.
 */
function bucket(
  buckets: Buckets,
  key: string,
  value: unknown,
  breakdownKeys: readonly string[],
): void {
  if (breakdownKeys.includes(key)) {
    const label = str(value) ?? (typeof value === 'number' ? String(value) : undefined);
    if (label !== undefined) buckets.breakdowns[key] = label;
    return;
  }
  if (Array.isArray(value)) {
    const total = actionTotal(value);
    if (total !== undefined) buckets.metrics[key] = total;
    return;
  }
  const parsed = num(value);
  if (parsed !== undefined) {
    buckets.metrics[key] = parsed;
    return;
  }
  const text = str(value);
  if (text !== undefined) buckets.labels[key] = text;
}

/** Fields handled elsewhere on the row, so they never reach {@link bucket}. */
function claimed(key: string): boolean {
  return (
    IDENTITY_KEYS.has(key) ||
    ACTION_KEYS.has(key) ||
    key === 'purchase_roas' ||
    key === 'website_purchase_roas'
  );
}

/** Map one raw row into a typed, labelled {@link InsightRow}. */
export function mapRow(
  raw: Record<string, unknown>,
  level: Level,
  breakdownKeys: readonly string[],
): InsightRow {
  const buckets: Buckets = { metrics: {}, labels: {}, breakdowns: {} };
  for (const [key, value] of Object.entries(raw)) {
    if (!claimed(key)) bucket(buckets, key, value, breakdownKeys);
  }

  // ROAS is a one-entry list (`omni_purchase`), and its entries are ratios:
  // summing them the way video milestones are summed would invent a number.
  const roas = actionMap(raw.purchase_roas) ?? actionMap(raw.website_purchase_roas);
  const { id, name } = identityFor(level, raw);

  return {
    id,
    name,
    level,
    accountId: str(raw.account_id),
    accountName: str(raw.account_name),
    campaignId: str(raw.campaign_id),
    campaignName: str(raw.campaign_name),
    adsetId: str(raw.adset_id),
    adsetName: str(raw.adset_name),
    adId: str(raw.ad_id),
    adName: str(raw.ad_name),
    objective: str(raw.objective),
    optimizationGoal: str(raw.optimization_goal),
    attributionSetting: str(raw.attribution_setting),
    currency: str(raw.account_currency),
    dateStart: str(raw.date_start),
    dateStop: str(raw.date_stop),
    breakdowns: Object.keys(buckets.breakdowns).length > 0 ? buckets.breakdowns : undefined,
    metrics: buckets.metrics,
    labels: Object.keys(buckets.labels).length > 0 ? buckets.labels : undefined,
    actions: actionMap(raw.actions),
    actionValues: actionMap(raw.action_values),
    costPerAction: actionMap(raw.cost_per_action_type),
    purchaseRoas: roas ? Object.values(roas)[0] : undefined,
  };
}

/**
 * The action types that mean "a purchase", in the order Meta prefers them.
 *
 * There is no single purchase metric: a pixel purchase, an app purchase and the
 * cross-surface roll-up are three different action types, and which one an
 * account reports depends on how it is set up. Reading only `purchase` reports
 * zero sales for a perfectly healthy app-install account.
 */
const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

/** The row's purchase count and value, whichever action type carries them. */
export function purchases(row: InsightRow): { count?: number; value?: number } {
  const type = PURCHASE_TYPES.find((candidate) => row.actions?.[candidate] !== undefined);
  if (type === undefined) return {};
  return { count: row.actions?.[type], value: row.actionValues?.[type] };
}

/** How a row should be named in prose: the entity, its breakdown, its day. */
export function rowLabel(row: InsightRow): string {
  const parts: string[] = [];
  if (row.name) parts.push(row.id ? `${row.name} (${row.id})` : row.name);
  else if (row.id) parts.push(row.id);
  if (row.breakdowns) parts.push(Object.values(row.breakdowns).join('/'));
  // A dated row must say its date, or a 30-row daily series reads as 30
  // identical copies of the same campaign.
  if (row.dateStart && row.dateStart !== row.dateStop)
    parts.push(`${row.dateStart}→${row.dateStop}`);
  else if (row.dateStart) parts.push(row.dateStart);
  return parts.join(' · ') || 'row';
}

/** One prose line for a row: spend, delivery, cost, and conversions if any. */
export function rowLine(row: InsightRow): string {
  const { spend, impressions, clicks, ctr, cpc } = row.metrics;
  const bits = [
    money(spend, row.currency),
    impressions === undefined ? undefined : `${group(impressions)} impr`,
    clicks === undefined ? undefined : `${group(clicks)} clicks`,
    ctr === undefined ? undefined : `${ctr.toFixed(2)}% CTR`,
    cpc === undefined ? undefined : `${money(cpc, row.currency)} CPC`,
  ].filter(Boolean);
  const { count, value } = purchases(row);
  if (count !== undefined) {
    const roas = row.purchaseRoas === undefined ? '' : `, ${row.purchaseRoas.toFixed(2)}× ROAS`;
    const revenue = value === undefined ? '' : ` worth ${money(value, row.currency)}`;
    bits.push(`${group(count)} purchases${revenue}${roas}`);
  }
  return `• ${rowLabel(row)} — ${bits.join(' · ')}`;
}

/** Totals across the returned rows. */
export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
  purchases?: number;
  purchaseValue?: number;
  currency?: string;
}

/**
 * Total the rows that were actually returned.
 *
 * Rates are RECOMPUTED from the totals, never averaged: the mean of per-row CTR
 * weights a campaign with 12 impressions the same as one with 12 million, which
 * is how a blended CTR ends up above every individual row's. And `reach` and
 * `frequency` are deliberately absent — reach is de-duplicated people, so
 * summing it double-counts everyone a campaign reached twice, and Meta's own
 * account-level reach is the only honest one.
 */
export function totalsOf(rows: readonly InsightRow[]): Totals {
  const sum = (key: string): number =>
    rows.reduce((running, row) => running + (row.metrics[key] ?? 0), 0);
  const spend = sum('spend');
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const purchaseCount = rows.reduce((running, row) => running + (purchases(row).count ?? 0), 0);
  const purchaseValue = rows.reduce((running, row) => running + (purchases(row).value ?? 0), 0);
  return {
    spend,
    impressions,
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : undefined,
    cpc: clicks > 0 ? spend / clicks : undefined,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : undefined,
    purchases: purchaseCount > 0 ? purchaseCount : undefined,
    purchaseValue: purchaseValue > 0 ? purchaseValue : undefined,
    currency: rows.find((row) => row.currency)?.currency,
  };
}

/** The totals line for the prose mirror. */
export function totalsLine(totals: Totals, rowCount: number): string {
  const bits = [
    `${money(totals.spend, totals.currency)} spend`,
    `${group(totals.impressions)} impressions`,
    `${group(totals.clicks)} clicks`,
  ];
  if (totals.ctr !== undefined) bits.push(`${totals.ctr.toFixed(2)}% CTR`);
  if (totals.cpc !== undefined) bits.push(`${money(totals.cpc, totals.currency)} CPC`);
  if (totals.purchases !== undefined) {
    bits.push(
      `${group(totals.purchases)} purchases worth ${money(totals.purchaseValue, totals.currency)}`,
    );
  }
  return `Across the ${rowCount} row(s) returned: ${bits.join(' · ')}`;
}
