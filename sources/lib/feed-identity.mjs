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
 * @param {import('./types.d.ts').FeedItem[]} items - The feed's parsed items.
 * @returns {string | undefined} The trimmed title, or undefined.
 */
export function feedSelfTitle(items) {
  const title = items.find((item) => item.feedTitle)?.feedTitle;
  return title ? title.trim() : undefined;
}

/**
 * Where a feed says it has permanently moved to, if anywhere.
 *
 * Two signals, in order of authority:
 *
 *  1. **`<itunes:new-feed-url>`** — the show's own instruction to its
 *     subscribers. An explicit statement of intent, and the only signal that
 *     survives the old host disappearing entirely.
 *  2. **A 301/308 redirect chain** — the host saying this resource lives
 *     elsewhere now. Weaker: a host may serve a permanent redirect for reasons
 *     that have nothing to do with the show (a domain consolidation, an
 *     http→https upgrade), and it is the platform speaking rather than the
 *     publisher. Still worth following, since plenty of moves are announced
 *     this way and no other.
 *
 * The tag wins where both are present, because a show that has published a
 * destination has said where it wants subscribers to end up.
 *
 * A feed that advertises its CURRENT address is not moving; that is a common
 * and perfectly correct thing to publish, so it is filtered here rather than
 * reported as a no-op relocation that would churn every round.
 *
 * @param {import('./types.d.ts').FeedItem[]} items - The feed's parsed items.
 * @param {string} fetchedUrl - The address actually fetched.
 * @param {string} [redirectedTo] - Where a permanent redirect chain led.
 * @returns {string | undefined} The new address, or undefined.
 */
export function feedRelocation(items, fetchedUrl, redirectedTo) {
  const declared = items.find((item) => item.feedNewUrl)?.feedNewUrl;
  const next = (declared || redirectedTo || '').trim();
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
    ...(titles.length === 1 && titles[0] && { feedName: titles[0] }),
    ...(relocations.length === 1 && relocations[0] && { feedUrl: relocations[0] }),
  };
}
