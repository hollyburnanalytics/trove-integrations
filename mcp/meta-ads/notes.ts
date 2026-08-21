import type { RateLimitReading } from './client.ts';
import { group, money } from './fields.ts';
import type { Totals } from './rows.ts';

/**
 * The footer every tool writes: what the answer does NOT contain.
 *
 * Three things about this API are invisible in a well-formed result and each
 * has burned somebody: a page of rows looks like the whole set, an empty result
 * looks like zero spend rather than "nothing delivered", and a rate-limit
 * budget that is nearly spent looks fine right up until the call that fails.
 * They are stated in prose, not only in the structured payload, because some
 * hosts render only the text.
 */

/** Say how close this ad account is to its insights rate limit, if Meta said. */
export function rateLimitNote(reading: RateLimitReading | undefined): string | undefined {
  if (!reading) return undefined;
  const parts: string[] = [];
  if (reading.accountUtilPct !== undefined) {
    parts.push(`account ${reading.accountUtilPct.toFixed(0)}%`);
  }
  if (reading.appUtilPct !== undefined) parts.push(`app ${reading.appUtilPct.toFixed(0)}%`);
  if (reading.regainAccessMinutes !== undefined) {
    return `RATE LIMITED: Meta estimates ${reading.regainAccessMinutes} minute(s) until this ad account's ads-insights budget recovers.`;
  }
  if (parts.length === 0) return undefined;
  const worst = Math.max(reading.accountUtilPct ?? 0, reading.appUtilPct ?? 0);
  const prefix = worst >= 75 ? 'RATE LIMIT WARNING' : 'Rate limit';
  const tier = reading.tier ? `, tier ${reading.tier}` : '';
  return `${prefix}: insights budget used — ${parts.join(', ')}${tier}.`;
}

/** Say plainly that the page is not the answer. */
export function truncationNote(
  returned: number,
  hasMore: boolean,
  cursor: string | undefined,
): string | undefined {
  if (!hasMore) return undefined;
  return (
    `TRUNCATED: ${returned} row(s) returned and Meta says there are more. ` +
    (cursor
      ? `Pass after: "${cursor}" for the next page, or raise limit.`
      : 'Raise limit to see more.')
  );
}

/** Meta's totals across every matching row, next to what this page holds. */
export function coverageNote(
  totals: Totals,
  summary: { spend?: number } | undefined,
): string | undefined {
  const overall = summary?.spend;
  if (overall === undefined || overall <= 0) return undefined;
  const share = (totals.spend / overall) * 100;
  return `These rows hold ${money(totals.spend, totals.currency)} of ${money(
    overall,
    totals.currency,
  )} total spend across all matching rows (${share.toFixed(1)}%).`;
}

/**
 * Why an empty result is not the same as a zero.
 *
 * Meta returns rows only for entities that DELIVERED in the window. A campaign
 * that was paused for the month, or never spent, is absent — so an empty answer
 * reported as "0 campaigns" invites the reading "the account is idle" when the
 * truth may be "everything ran before this window".
 */
export function emptyNote(level: string, window: string): string {
  return (
    `No ${level} rows with delivery ${window}. Meta reports insights only for entities that ` +
    'spent or served in the window — a paused or never-delivered ' +
    `${level} is absent rather than zero. Use list_entities to see what exists, or widen the range.`
  );
}

/** The one-line window description used in prose. */
export function windowLabel(
  datePreset: string | undefined,
  since: string | undefined,
  until: string | undefined,
): string {
  if (since && until) return `${since} → ${until}`;
  return `over ${datePreset ?? 'last_30d'}`;
}

/** Warn before a row explosion the caller did not ask for. */
export function granularityNote(
  level: string,
  increment: string,
  breakdownCount: number,
): string | undefined {
  if (increment === 'all_days' && breakdownCount === 0) return undefined;
  if (level !== 'ad' && breakdownCount < 2) return undefined;
  return (
    `Row count multiplies here: level "${level}"` +
    (increment === 'all_days' ? '' : ` × ${increment} rows`) +
    (breakdownCount > 0 ? ` × ${breakdownCount} breakdown(s)` : '') +
    '. If the result is truncated, narrow the window rather than raising limit.'
  );
}

/** Render a totals object into the compact `key: value` prose tail. */
export function compactTotals(totals: Totals): string {
  return `${money(totals.spend, totals.currency)} / ${group(totals.impressions)} impr / ${group(
    totals.clicks,
  )} clicks`;
}
