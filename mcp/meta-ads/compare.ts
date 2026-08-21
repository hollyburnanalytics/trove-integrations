import { ToolError, z } from '@ontrove/extend/toolkit';
import { group, money } from './fields.ts';
import { type InsightRow, purchases, type Totals } from './rows.ts';

/**
 * Period-over-period maths: pairing two windows of rows and saying what moved.
 *
 * Kept out of the tool so the two halves of a comparison are built and read by
 * the same code. The subtle part is not the subtraction — it is the entities
 * that appear in only ONE window. A campaign that launched this week has no
 * "before", and one that was switched off has no "after"; treated as zeroes
 * they read as infinite growth and total collapse, so they are labelled instead.
 */

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** How the baseline window is chosen. */
export const COMPARE_MODES = ['previous_period', 'previous_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

/** A `YYYY-MM-DD` day as epoch ms, or a named error. */
function day(value: string, field: string): number {
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

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The same calendar day one year earlier, clamped rather than rolled.
 *
 * `setUTCFullYear(year - 1)` on 29 February answers 1 March, because the target
 * year has no 29th — so a February window compared year-over-year would quietly
 * start a day late and end in the wrong month. A day that does not exist in the
 * earlier year clamps to that month's last day instead.
 */
function yearBefore(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, month, Math.min(date.getUTCDate(), lastOfMonth)));
}

/**
 * The window to compare against.
 *
 * `previous_period` is the same NUMBER OF DAYS immediately before the current
 * window, so a 14-day window is compared with 14 days and not with a month.
 * `previous_year` is the same calendar dates a year earlier — which does not
 * align weekdays, and weekday seasonality is real in ad delivery, so the tool
 * says so rather than quietly shifting the dates by 364.
 */
export function baselineWindow(
  since: string,
  until: string,
  mode: CompareMode,
): { since: string; until: string } {
  const from = day(since, 'since');
  const to = day(until, 'until');
  if (from > to) {
    throw new ToolError(`since (${since}) is after until (${until}).`, { retryable: false });
  }
  if (mode === 'previous_year') return { since: yearBefore(from), until: yearBefore(to) };
  const lengthMs = to - from + DAY_MS;
  return { since: iso(from - lengthMs), until: iso(from - DAY_MS) };
}

/** A before/after pair and the movement between them. */
export const deltaShape = z.object({
  before: z.number().optional(),
  after: z.number().optional(),
  change: z.number().optional(),
  changePct: z.number().optional(),
});

export type Delta = z.infer<typeof deltaShape>;

/**
 * Compare two values.
 *
 * A percentage change from zero is not "infinite growth", it is undefined — so
 * `changePct` is simply absent there, and the absolute change carries the story.
 */
export function delta(before: number | undefined, after: number | undefined): Delta {
  if (before === undefined && after === undefined) return {};
  const change =
    before !== undefined && after !== undefined ? after - before : (after ?? 0) - (before ?? 0);
  const changePct = before !== undefined && before !== 0 ? (change / before) * 100 : undefined;
  return { before, after, change, changePct };
}

/** One entity's before/after. */
export const comparisonShape = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  presence: z.enum(['both', 'new', 'stopped', 'unpaired']),
  currency: z.string().optional(),
  spend: deltaShape,
  impressions: deltaShape,
  clicks: deltaShape,
  ctr: deltaShape,
  cpc: deltaShape,
  purchases: deltaShape,
  purchaseValue: deltaShape,
  roas: deltaShape,
});

export type Comparison = z.infer<typeof comparisonShape>;

/** The key an entity is joined on across the two windows. */
function keyOf(row: InsightRow): string {
  return row.id ?? row.name ?? 'account';
}

/**
 * Whether a one-sided entity really is new or stopped.
 *
 * Only if the window it is missing from was COMPLETE. Each window is fetched
 * top-spend-first, so when a page was truncated an entity absent from it may
 * simply have ranked below the cutoff — calling that "NEW" is a fabricated
 * story about a campaign that has been running for months. `unpaired` is the
 * honest label for "cannot tell from what was returned".
 */
function presenceOf(
  hasBefore: boolean,
  hasAfter: boolean,
  truncated: Truncation,
): Comparison['presence'] {
  if (hasBefore && hasAfter) return 'both';
  if (hasAfter) return truncated.baseline ? 'unpaired' : 'new';
  return truncated.current ? 'unpaired' : 'stopped';
}

/** Which of the two windows came back as a partial page. */
export interface Truncation {
  baseline: boolean;
  current: boolean;
}

/** Build the before/after record for one entity. */
function compareOne(
  before: InsightRow | undefined,
  after: InsightRow | undefined,
  truncated: Truncation,
): Comparison {
  const current = after ?? before;
  const presence = presenceOf(before !== undefined, after !== undefined, truncated);
  const beforeBuys = before ? purchases(before) : {};
  const afterBuys = after ? purchases(after) : {};
  const metric = (key: string): Delta => delta(before?.metrics[key], after?.metrics[key]);
  return {
    id: current?.id,
    name: current?.name,
    presence,
    currency: current?.currency,
    spend: metric('spend'),
    impressions: metric('impressions'),
    clicks: metric('clicks'),
    ctr: metric('ctr'),
    cpc: metric('cpc'),
    purchases: delta(beforeBuys.count, afterBuys.count),
    purchaseValue: delta(beforeBuys.value, afterBuys.value),
    roas: delta(before?.purchaseRoas, after?.purchaseRoas),
  };
}

/**
 * Pair the two windows' rows, biggest absolute spend move first.
 *
 * Ranked by the SIZE of the move rather than by spend, because the question a
 * comparison answers is "what changed" — a steady top spender is not news, and
 * a mid-sized campaign that doubled is.
 */
export function comparePairs(
  baseline: readonly InsightRow[],
  current: readonly InsightRow[],
  truncated: Truncation,
): Comparison[] {
  const before = new Map(baseline.map((row) => [keyOf(row), row]));
  const after = new Map(current.map((row) => [keyOf(row), row]));
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .map((key) => compareOne(before.get(key), after.get(key), truncated))
    .sort((a, b) => Math.abs(b.spend.change ?? 0) - Math.abs(a.spend.change ?? 0));
}

/** Render a delta as `before → after (+x%)`. */
function deltaText(value: Delta, format: (n: number) => string): string {
  if (value.before === undefined && value.after === undefined) return 'n/a';
  const beforeText = value.before === undefined ? '—' : format(value.before);
  const afterText = value.after === undefined ? '—' : format(value.after);
  const pct =
    value.changePct === undefined
      ? ''
      : ` (${value.changePct >= 0 ? '+' : ''}${value.changePct.toFixed(1)}%)`;
  return `${beforeText} → ${afterText}${pct}`;
}

/** One prose line per compared entity. */
export function comparisonLine(row: Comparison): string {
  const asMoney = (value: number): string => money(value, row.currency);
  const bits = [
    `spend ${deltaText(row.spend, asMoney)}`,
    `clicks ${deltaText(row.clicks, (value) => group(value))}`,
    `CTR ${deltaText(row.ctr, (value) => `${value.toFixed(2)}%`)}`,
  ];
  if (row.purchases.before !== undefined || row.purchases.after !== undefined) {
    bits.push(`purchases ${deltaText(row.purchases, (value) => group(value))}`);
  }
  const tag = row.presence === 'both' ? '' : ` [${row.presence.toUpperCase()}]`;
  return `• ${row.name ?? row.id ?? 'account'}${tag} — ${bits.join(' · ')}`;
}

/** The window-over-window movement of the totals of the rows returned. */
export interface TotalsDelta {
  spend: Delta;
  impressions: Delta;
  clicks: Delta;
  ctr: Delta;
  purchases: Delta;
  purchaseValue: Delta;
  currency?: string;
}

/**
 * Compare two windows' totals.
 *
 * These are totals of the ROWS RETURNED, not of the account — a distinction the
 * caller is told about whenever either page was truncated.
 */
export function totalsDelta(before: Totals, after: Totals): TotalsDelta {
  return {
    spend: delta(before.spend, after.spend),
    impressions: delta(before.impressions, after.impressions),
    clicks: delta(before.clicks, after.clicks),
    ctr: delta(before.ctr, after.ctr),
    purchases: delta(before.purchases, after.purchases),
    purchaseValue: delta(before.purchaseValue, after.purchaseValue),
    currency: after.currency ?? before.currency,
  };
}

/** The totals line for a comparison's prose mirror. */
export function totalsDeltaLine(totals: TotalsDelta): string {
  const spend = deltaText(totals.spend, (value) => money(value, totals.currency));
  return `Totals across the rows shown: spend ${spend}`;
}
