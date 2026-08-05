/**
 * The podcast directory — keyword search and trending over Podcast Index.
 *
 * A *directory* answers "what could go in this config field?", which is a
 * different job from a *source adapter*: it produces candidates a person picks
 * from, never documents. It is called at configure time, not on a schedule.
 *
 * **This module handles no credentials.** It declares an auth strategy by name
 * and calls `context.fetch`; trove-api signs on the way out. That is a requirement
 * rather than a preference — Podcast Index's terms bar embedding developer
 * credentials in open source projects, and this repository is public.
 *
 * An empty query is legal and means "what should we show before they type",
 * which the trending endpoint answers. There is deliberately no bundled list of
 * shows: a shipped array of feed URLs rots between releases with no signal.
 *
 * @module
 */

/** The auth strategy trove-api applies to this provider's requests. */
export const auth = 'podcast-index';

/** Single region-less API base. */
const BASE = 'https://api.podcastindex.org/api/1.0';

/**
 * Coerce Podcast Index's `newestItemPubdate` (unix seconds) to an ISO string.
 * Their API returns `0` for "never published", which is not a date — a show
 * with no episodes must read as unknown rather than as 1970.
 *
 * @param {unknown} seconds - The raw field.
 * @returns {string | undefined} ISO-8601, or undefined when absent/meaningless.
 */
function isoFromUnix(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
  const ms = seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Project one Podcast Index feed object onto a DirectoryEntry.
 *
 * Rows without a usable feed URL or title are dropped by returning nothing — an
 * entry Trove cannot subscribe to has no business being offered, and one with
 * no name cannot be chosen between.
 *
 * @param {Record<string, unknown>} feed - A raw `feeds` entry.
 * @returns {object | undefined} The entry, or undefined when unusable.
 */
function toEntry(feed) {
  const value = typeof feed.url === 'string' ? feed.url.trim() : '';
  const title = typeof feed.title === 'string' ? feed.title.trim() : '';
  if (value === '' || title === '') return;

  const subtitle = typeof feed.author === 'string' ? feed.author.trim() : '';
  const description = typeof feed.description === 'string' ? feed.description.trim() : '';
  const imageUrl = typeof feed.image === 'string' ? feed.image.trim() : '';
  const itemCount = typeof feed.episodeCount === 'number' ? feed.episodeCount : undefined;
  const latestAt = isoFromUnix(feed.newestItemPubdate);

  return {
    value,
    title,
    ...(subtitle !== '' && { subtitle }),
    ...(description !== '' && { description }),
    ...(imageUrl !== '' && { imageUrl }),
    ...(itemCount !== undefined && { itemCount }),
    ...(latestAt !== undefined && { latestAt }),
  };
}

/**
 * Fetch and project one endpoint's `feeds` array.
 *
 * A non-2xx response throws rather than returning nothing: an empty list reads
 * to a person as "no such show", which is a different and misleading claim from
 * "the directory is unreachable".
 *
 * @param {object} context - The directory context (signing fetch + log).
 * @param {URL} url - The endpoint to call.
 * @returns {Promise<object[]>} Usable entries.
 */
async function fetchEntries(context, url) {
  const response = await context.fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Podcast Index returned ${String(response.status)} for ${url.pathname}`);
  }
  const body = await response.json();
  const feeds = Array.isArray(body?.feeds) ? body.feeds : [];
  const entries = [];
  for (const feed of feeds) {
    if (feed === null || typeof feed !== 'object') continue;
    const entry = toEntry(feed);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * Answer a directory query.
 *
 * @param {{ query?: string, limit: number }} input - The query; empty means featured.
 * @param {object} context - The directory context.
 * @returns {Promise<object[]>} Candidate shows.
 */
export async function query(input, context) {
  const term = typeof input.query === 'string' ? input.query.trim() : '';
  const max = String(input.limit);

  if (term === '') {
    // The featured set: what is moving right now, rather than a curated list
    // that would need maintaining and would drift silently between releases.
    const url = new URL(`${BASE}/podcasts/trending`);
    url.searchParams.set('max', max);
    return fetchEntries(context, url);
  }

  const url = new URL(`${BASE}/search/byterm`);
  url.searchParams.set('q', term);
  url.searchParams.set('max', max);
  // Deliberately no `clean` filter: that parameter means "non-explicit feeds
  // only", not "drop dead shows", and applying it would silently hide
  // legitimate results a person searched for by name. Staleness is handled
  // where it belongs — the client demotes dormant shows by `latestAt`.
  return fetchEntries(context, url);
}

/**
 * Look a show up by a feed URL it used to live at.
 *
 * This is **repair, not identity**. A subscription is addressed by its URL, and
 * a well-behaved move announces itself — `<itunes:new-feed-url>` or a permanent
 * redirect. Some moves are not well-behaved: the old host simply stops
 * answering. The index has usually seen where the show went, because it tracks
 * feeds rather than addresses.
 *
 * Only ever called for a feed that has already died, so it costs nothing on the
 * healthy path and puts no third party between Trove and a working feed.
 *
 * @param {string} url - The address that stopped answering.
 * @param {object} context - The directory context (signing fetch + log).
 * @returns {Promise<object | undefined>} The show as the index knows it today.
 */
export async function lookup(url, context) {
  const endpoint = new URL(`${BASE}/podcasts/byfeedurl`);
  endpoint.searchParams.set('url', url);

  const response = await context.fetch(endpoint.toString());
  // 404 is a real answer here — the index has never heard of this feed — and is
  // not worth failing a repair attempt over.
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`Podcast Index returned ${String(response.status)} for ${endpoint.pathname}`);
  }

  const body = await response.json();
  const feed = body?.feed;
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) return;
  return toEntry(feed);
}
