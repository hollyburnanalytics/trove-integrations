/**
 * What a feed says about *itself* — its name and its address — as distinct from
 * the items it carries (trove docs/39 D10 and the relocation work that follows).
 *
 * A fan-out subscription row is created named after, and addressed by, the URL
 * the user configured, because at that moment it is the only string there is.
 * The feed itself knows better: it publishes a title, and when a show moves
 * hosts it publishes where it went. This module reads those two claims; the
 * cloud seam decides whether to act on them, because only the seam may write
 * tenant rows.
 *
 * The single-feed rule is the load-bearing part. Both facts describe ONE
 * subscription, so they may only be reported when a round covered exactly one
 * feed. With several feeds in a round there is no single row either claim
 * belongs to, and misapplying one would rename a subscription after another
 * show — or worse, point it at another show's feed.
 *
 * @module
 */

/**
 * What a feed calls itself, read off its items.
 *
 * The parsers stamp the channel title onto every item (`rss-parse` sets
 * `feedTitle`), so this needs no second pass over the document. A feed carrying
 * no items yields nothing, which is the honest answer rather than a guess.
 *
 * @param {object[]} items - The feed's parsed items.
 * @returns {string | undefined} The trimmed title, or undefined.
 */
export function feedSelfTitle(items) {
  const title = items.find((item) => item.feedTitle)?.feedTitle;
  return title ? title.trim() : undefined;
}

/**
 * Where a feed says it has permanently moved to, if anywhere.
 *
 * `<itunes:new-feed-url>` is the show's own instruction to its subscribers,
 * which makes it the most authoritative relocation signal there is — better
 * than a third-party index, which learns of the move the same way and later.
 *
 * A feed that advertises its CURRENT address is not moving; that is a common
 * and perfectly correct thing for a channel to publish, so it is filtered here
 * rather than reported as a no-op relocation that would churn every round.
 *
 * @param {object[]} items - The feed's parsed items.
 * @param {string} fetchedUrl - The address actually fetched.
 * @returns {string | undefined} The new address, or undefined.
 */
export function feedRelocation(items, fetchedUrl) {
  const moved = items.find((item) => item.feedNewUrl)?.feedNewUrl;
  if (!moved) return;
  const next = moved.trim();
  return next && next !== fetchedUrl ? next : undefined;
}

/**
 * The self-reported facts to attach to a sync result, or nothing.
 *
 * @param {{feedCount: number, titles: string[], relocations: string[]}} seen
 * @returns {{feedName?: string, feedUrl?: string}} Spreadable onto a SyncResult.
 */
export function selfReport({ feedCount, titles, relocations }) {
  if (feedCount !== 1) return {};
  return {
    ...(titles.length === 1 && titles[0] ? { feedName: titles[0] } : {}),
    ...(relocations.length === 1 && relocations[0] ? { feedUrl: relocations[0] } : {}),
  };
}
