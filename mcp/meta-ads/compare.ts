import { ToolError, z } from '@ontrove/extend/toolkit';
import { group, money } from './fields.ts';
import { type InsightRow, purchases } from './rows.ts';

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
  if (mode === 'previous_year') {
    const shift = (ms: number): string => {
      const date = new Date(ms);
      date.setUTCFullYear(date.getUTCFullYear() - 1);
      return iso(date.getTime());
    };
    return { since: shift(from), until: shift(to) };
  }
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
  presence: z.enum(['both', 'new', 'stopped']),
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

/** Build the before/after record for one entity. */
function compareOne(before: InsightRow | undefined, after: InsightRow | undefined): Comparison {
  const current = after ?? before;
  const presence: Comparison['presence'] = before && after ? 'both' : after ? 'new' : 'stopped';
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
): Comparison[] {
  const before = new Map(baseline.map((row) => [keyOf(row), row]));
  const after = new Map(current.map((row) => [keyOf(row), row]));
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .map((key) => compareOne(before.get(key), after.get(key)))
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
