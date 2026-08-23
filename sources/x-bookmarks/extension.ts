import { defineSource } from '@ontrove/extend/source';
import { hasDeadlinePassed, htmlToText, safeDate, stableId } from '../lib/feeds.mjs';

/**
 * X (Twitter) Bookmarks — your saved posts, synced into Trove.
 *
 * Reads `GET /2/users/:id/bookmarks` (your ~800 most recent, paginated
 * newest-by-bookmark-time first) using OAuth 2.0 **user-context** with the
 * `bookmark.read` scope — the app-only Bearer the read tools use cannot reach
 * this endpoint. Credentials arrive via `ctx.secret()`:
 *  - `X_OAUTH_CLIENT_ID`      (required)
 *  - `X_OAUTH_REFRESH_TOKEN`  (required; obtain once via scripts/x-authorize.mjs)
 *  - `X_OAUTH_CLIENT_SECRET`  (optional; only for a confidential client)
 *
 * Each run mints a short-lived (~2h) access token from the refresh-token grant.
 * Resume uses an **`idSet`** cursor of recently-seen tweet ids: we page from
 * the top and stop the moment we hit an id we've already ingested, so steady
 * state only fetches what's new. The run is bounded by a page cap and the host's
 * soft deadline, so a first backfill splits cleanly across runs.
 *
 * NOTE on refresh-token rotation: X returns a NEW `refresh_token` on every grant
 * and invalidates the old one. Production-grade persistence of that rotated token
 * must be owned by the harness/keychain (it re-supplies the credential next
 * run). This source deliberately does NOT write the rotated token into the
 * cursor — credentials must never live in cursor state — and uses the freshly
 * minted access token only for the duration of the current run.
 */

const BASE_URL = 'https://api.x.com';
const TOKEN_URL = `${BASE_URL}/2/oauth2/token`;
const TWEET_FIELDS = 'created_at,public_metrics,entities,referenced_tweets';
const USER_FIELDS = 'name,username';
const PAGE_SIZE = 100; // API max bookmarks per page
const MAX_PAGES = 5; // bound API calls per run (a deadline can stop us sooner)
const MAX_SEEN_IDS = 1000; // cap the idSet cursor (bookmarks top out at ~800)
const TITLE_MAX = 80;
const USER_AGENT = 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)';

/**
 * The X payloads this source reads, and the cursor it has to keep reading.
 */
type XUser = { id: string; name?: string; username?: string };
type XTweet = {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  entities?: { hashtags?: Array<{ tag?: string }> };
};
type BookmarksPage = {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { next_token?: string };
};
type StoredCursor = { type?: string; values?: unknown; value?: unknown };

/**
 * Honest, attributable headers carrying a user-context Bearer.
 *
 * @param accessToken - The short-lived token minted this run.
 * @returns The request headers.
 */
function authHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
}

/**
 * Read the previous `idSet` cursor as a (newest-first) array of tweet ids.
 *
 * Reads BOTH shapes on purpose. This source used to store the set under
 * `value`, deliberately unlike the SDK's `{ values, max }`, and the
 * deviation was invisible because the reader and the writer agreed with each
 * other. It was not invisible to the platform: Trove's `parseWatermark` requires
 * `values`, so a `value` cursor parses to null — the feed would resume from
 * nothing on every run and re-fetch every bookmark, and its cursor could not
 * be displayed at all.
 *
 * Harmless only because this source is Mac-located, where the raw cursor is
 * handed back untouched. It would have started silently re-fetching the moment
 * anyone moved it to the cloud.
 *
 * The legacy branch stays for one release so an existing Mac cursor is not
 * discarded on upgrade; new cursors are always written as `values`.
 *
 * @param cursor - Whatever the previous run returned.
 * @returns The seen ids, newest-first.
 */
function readSeenIds(cursor: unknown): string[] {
  const stored = cursor as StoredCursor | undefined;
  if (stored?.type !== 'idSet') return [];
  if (Array.isArray(stored.values)) return stored.values.map(String);
  return Array.isArray(stored.value) ? stored.value.map(String) : [];
}

/**
 * Exchange the rotating refresh token for a short-lived access token. Throws a
 * clear, token-free error when credentials are absent or the grant is rejected.
 *
 * @param context - The harness context.
 * @returns The access token, valid for this run only.
 */
async function refreshAccessToken(
  context: import('../lib/types.js').SourceContext,
): Promise<string> {
  const clientId = await context.requireSecret('X_OAUTH_CLIENT_ID');
  const refreshToken = await context.requireSecret('X_OAUTH_REFRESH_TOKEN');

  // Optional, and genuinely so: a PUBLIC OAuth client has no secret at all, and
  // X accepts the refresh without one. `secret` rather than `requireSecret` is
  // the whole distinction between the two — see @ontrove/extend's ExtensionContext.
  const clientSecret = await context.secret('X_OAUTH_CLIENT_SECRET');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  // Confidential clients additionally authenticate with HTTP Basic.
  if (clientSecret) {
    const basic = btoa(`${clientId}:${clientSecret}`);
    headers.authorization = `Basic ${basic}`;
  }

  const response = await fetch(TOKEN_URL, { method: 'POST', headers, body: form.toString() });
  if (!response.ok) {
    // Never surface token values. A 400/401 means the rotated refresh token is dead.
    throw new Error(
      `X token refresh failed (HTTP ${response.status}). ` +
        'Re-run scripts/x-authorize.mjs and update X_OAUTH_REFRESH_TOKEN.',
    );
  }
  const data: { access_token?: string } = await response.json();
  if (!data.access_token) throw new Error('X token refresh returned no access_token.');
  // data.refresh_token is the NEW rotated token; see the module note — we do not
  // persist it here (the harness owns rotation) and never write it to the cursor.
  return data.access_token;
}

/**
 * Resolve the bookmark owner's user id via `/2/users/me`.
 *
 * @param accessToken - The user-context token.
 * @returns The account's numeric id.
 */
async function fetchUserId(accessToken: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/2/users/me`, { headers: authHeaders(accessToken) });
  if (!response.ok) throw new Error(`X /2/users/me failed (HTTP ${response.status}).`);
  const data: { data?: { id?: string } } = await response.json();
  const id = data?.data?.id;
  if (!id) throw new Error('Could not resolve X user id for bookmarks.');
  return id;
}

/**
 * The tweets on one page that are new, stopping at the first already stored.
 *
 * The bookmarks timeline is newest-first, so the first familiar id means every
 * tweet below it on this page — and on every later page — is already here.
 * Counting those as skipped rather than walking them is what keeps a routine
 * sync to one page.
 *
 * @param tweets - The page, newest first.
 * @param seenIds - Bookmark ids already stored.
 * @returns The new
 *   tweets, how many were passed over, and whether the page ran into the
 *   already-stored ones.
 */
function freshBookmarks(
  tweets: XTweet[],
  seenIds: Set<string>,
): { tweets: XTweet[]; skipped: number; reachedSeen: boolean } {
  for (const [index, tweet] of tweets.entries()) {
    if (seenIds.has(tweet.id)) {
      // This id and every older one on the page.
      return { tweets: tweets.slice(0, index), skipped: tweets.length - index, reachedSeen: true };
    }
  }
  return { tweets, skipped: 0, reachedSeen: false };
}

/**
 * Fetch one page of bookmarks (newest-first).
 *
 * @param accessToken - The user-context token.
 * @param userId - Whose bookmarks to read.
 * @param paginationToken - Where to resume, from the previous page.
 * @returns The page as X returned it.
 */
async function fetchBookmarksPage(
  accessToken: string,
  userId: string,
  paginationToken?: string,
): Promise<BookmarksPage> {
  const parameters = new URLSearchParams({
    max_results: String(PAGE_SIZE),
    'tweet.fields': TWEET_FIELDS,
    expansions: 'author_id',
    'user.fields': USER_FIELDS,
  });
  if (paginationToken) parameters.set('pagination_token', paginationToken);
  const url = `${BASE_URL}/2/users/${encodeURIComponent(userId)}/bookmarks?${parameters.toString()}`;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  if (!response.ok) throw new Error(`X bookmarks request failed (HTTP ${response.status}).`);
  return response.json();
}

/**
 * Index `includes.users` by id for author joins.
 *
 * @param includes - The page's expansions.
 * @returns The users, by id.
 */
function indexUsers(includes: { users?: XUser[] } | undefined): Map<string, XUser> {
  const usersById: Map<string, XUser> = new Map();
  const users = includes?.users ?? [];
  for (const user of users) {
    if (user?.id) usersById.set(user.id, user);
  }
  return usersById;
}

/**
 * A short, single-line title prefix derived from the post body.
 *
 * @param text - The post's text.
 * @param handle - The author's handle, when the join resolved one.
 * @returns The title.
 */
function buildTitle(text: string, handle?: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  if (!flat) return handle ? `@${handle} on X` : 'X Bookmark';
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/**
 * Map one bookmarked tweet to a Trove document.
 *
 * @param tweet - The bookmarked post.
 * @param usersById - The page's author expansions.
 * @returns The document.
 */
function mapBookmark(
  tweet: XTweet,
  usersById: Map<string, XUser>,
): import('../lib/types.js').Document {
  const author = usersById.get(tweet.author_id ?? '');
  const handle = author?.username;
  const text = htmlToText(tweet.text ?? '');
  const hashtags = (tweet.entities?.hashtags ?? [])
    .map((entry) => entry.tag)
    .filter((tag) => tag !== undefined);
  return {
    id: stableId('x-bm', tweet.id),
    title: buildTitle(text, handle),
    text,
    url: handle
      ? `https://x.com/${handle}/status/${tweet.id}`
      : `https://x.com/i/status/${tweet.id}`,
    author: handle ? `@${handle}` : author?.name,
    date: safeDate(tweet.created_at),
    tags: hashtags.length > 0 ? hashtags : undefined,
  };
}

/**
 * Page from the top, collecting new bookmarks until we hit an already-seen id,
 * run out of pages, exhaust the page cap, or reach the host deadline. Because
 * the feed is newest-first, the first seen id means everything below it is older
 * and already ingested — so we stop without re-walking the tail.
 *
 * @param context - The harness context.
 * @param accessToken - The user-context token.
 * @param userId - Whose bookmarks to read.
 * @param seenIds - Ids already ingested on a previous run.
 * @returns {Promise<{ documents: import('../lib/types.js').Document[],
 *   newIdsNewestFirst: string[], skipped: number }>} What this round collected.
 */
async function collectNewBookmarks(
  context: import('../lib/types.js').SourceContext,
  accessToken: string,
  userId: string,
  seenIds: Set<string>,
) {
  const documents: import('../lib/types.js').Document[] = [];
  const newIdsNewestFirst: string[] = [];
  let skipped = 0;
  let paginationToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (hasDeadlinePassed(context)) {
      context.log.info('Time budget reached — resuming next run');
      break;
    }
    const body = await fetchBookmarksPage(accessToken, userId, paginationToken);
    const usersById = indexUsers(body.includes);
    const tweets = Array.isArray(body.data) ? body.data : [];

    const fresh = freshBookmarks(tweets, seenIds);
    for (const tweet of fresh.tweets) {
      documents.push(mapBookmark(tweet, usersById));
      newIdsNewestFirst.push(tweet.id);
    }
    skipped += fresh.skipped;
    context.progress(documents.length, `${documents.length} new bookmarks`);
    // A page that reached an id already stored is the end of what is new: the
    // timeline is newest-first, so everything below it is older and already here.
    if (fresh.reachedSeen) break;

    paginationToken = body.meta?.next_token;
    if (!paginationToken) break;
  }

  return { documents, newIdsNewestFirst, skipped };
}

export default defineSource({
  id: 'x-bookmarks',
  name: 'X Bookmarks',
  description:
    "Your saved X (Twitter) bookmarks, synced into Trove (your ~800 most recent, newest-first). Not yet available: X sign-in for this source can't be completed in the app yet.",
  icon: '🔖',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'idSet',
  ingest: 'append',
  runsIn: 'mac',
  schedule: 'every 6 hours',
  status: 'implemented',
  needsBrowser: false,
  egress: ['api.x.com'],
  egressNote: 'The X API v2 only. x.com appears in stored document URLs but is never fetched.',
  egressNotFetched: ['x.com'],
  available: false,
  secrets: ['X_OAUTH_CLIENT_ID', 'X_OAUTH_CLIENT_SECRET', 'X_OAUTH_REFRESH_TOKEN'],
  async sync(context) {
    const previousIds = readSeenIds(context.cursor);
    const seenIds = new Set(previousIds);

    const accessToken = await refreshAccessToken(context);
    const userId = await fetchUserId(accessToken);

    const { documents, newIdsNewestFirst, skipped } = await collectNewBookmarks(
      context,
      accessToken,
      userId,
      seenIds,
    );

    // idSet cursor: this run's new ids (newest-first) ahead of the prior set,
    // deduped and capped to the newest MAX_SEEN_IDS so the cursor stays bounded.
    const ordered = [...newIdsNewestFirst, ...previousIds];
    const boundedIds = [...new Set(ordered)].slice(0, MAX_SEEN_IDS);

    context.log.info(`Fetched ${documents.length} new bookmark(s)`);
    return {
      documents,
      // `values` + `max`, the shape the platform parses. See readSeenIds above
      // for why this is not `value`.
      cursor: { type: 'idSet', values: boundedIds, max: MAX_SEEN_IDS },
      stats: { fetched: documents.length, skipped },
    };
  },
});
