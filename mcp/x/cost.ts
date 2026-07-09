/**
 * X's pay-per-use read pricing and the `note` string every tool surfaces to
 * report what a call cost. Rates are the official per-resource fees; the tools
 * add per-request flat fees (counts) inline.
 */

/** X's official per-resource read rates (pay-per-use): https://docs.x.com/x-api/getting-started/pricing */
export const POST_READ_USD = 0.005;
export const USER_READ_USD = 0.01;
/** "Owned read" — your OWN data via user-context (bookmarks, likes): $0.001/resource. */
export const OWNED_READ_USD = 0.001;

/**
 * The metered cost of a call, surfaced to the agent/user in the `note` field:
 * the official per-resource rates plus this call's resource count and dollar
 * total. `unit` is 'post' (other people's posts, $0.005) or 'bookmark' (your own
 * data — an "owned read" at the discounted $0.001 rate).
 */
export function costNote(
  resources: number,
  userLookups: number,
  unit: 'post' | 'bookmark' = 'post',
): string {
  const owned = unit === 'bookmark';
  const rate = owned ? OWNED_READ_USD : POST_READ_USD;
  const rateLabel = owned
    ? '$0.001/bookmark (owned read) + $0.010/user lookup'
    : '$0.005/post + $0.010/user lookup';
  const dollars = resources * rate + userLookups * USER_READ_USD;
  const parts: string[] = [];
  if (resources > 0) parts.push(`${resources} ${unit}${resources === 1 ? '' : 's'}`);
  if (userLookups > 0) parts.push(`${userLookups} user lookup${userLookups === 1 ? '' : 's'}`);
  const what = parts.length > 0 ? parts.join(' + ') : 'nothing billable';
  return (
    `X meters reads at ${rateLabel} (official X API pricing; same-resource re-reads ` +
    `within a UTC day are free). This call read ${what} ≈ $${dollars.toFixed(3)}.`
  );
}
