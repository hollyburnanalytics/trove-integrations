/**
 * X (Twitter) — a hosted, read-only MCP server over the official X API v2
 * (api.x.com). Seven read surfaces:
 *  - `get_user_tweets`  — a person's recent posts (handle → id → timeline),
 *                         choose originals/reposts/replies via `include`,
 *  - `get_tweet`        — expand one post (by id or x.com URL) + its quoted/
 *                         replied-to context,
 *  - `get_post_replies` — the reply thread under a post (conversation_id → search),
 *  - `search_posts`     — search over X's operators, recent (last 7 days) OR the
 *                         full archive back to 2006 via a `scope` knob; filter by
 *                         post type via `post_types`,
 *  - `count_posts`      — how many posts match a query, WITHOUT reading them
 *                         (recent OR full archive via `scope`) — price a search
 *                         before you pull it,
 *  - `resolve_user`     — handle → profile (bio, follower counts, verified), and
 *  - `get_bookmarks`    — your own most-recent bookmarks (user-context OAuth).
 *
 * The six app-only read tools use a static, app-only **Bearer Token** (read-only,
 * long-lived) issued in the X developer portal — NOT an OAuth dance. It is
 * redeemed at call time via `ctx.requireSecret('X_BEARER_TOKEN')` (never bundled
 * or logged) and attached as `Authorization: Bearer <token>`. Set it with
 * `trove secret set x X_BEARER_TOKEN <token>`.
 *
 * `get_bookmarks` is different: `GET /2/users/:id/bookmarks` requires OAuth 2.0
 * **user-context** with the `bookmark.read` scope, which the app-only Bearer
 * cannot satisfy. It runs the refresh-token grant against
 * `POST /2/oauth2/token` using `X_OAUTH_CLIENT_ID` (+ optional
 * `X_OAUTH_CLIENT_SECRET` as HTTP Basic for a confidential client) and
 * `X_OAUTH_REFRESH_TOKEN`. Access tokens last ~2h and refresh tokens ROTATE
 * (each refresh returns a new one), so the freshly minted access token + rotated
 * refresh token are held in a module-level cache for the life of the warm
 * isolate. Obtain the first refresh token with `scripts/x-authorize.mjs`.
 *
 * Cost: X meters every read per its official pay-per-use pricing
 * (https://docs.x.com/x-api/getting-started/pricing): $0.005 per post read,
 * $0.010 per user lookup (e.g. resolving a handle), and a discounted $0.001
 * "owned read" for your OWN data via user-context — which is what `get_bookmarks`
 * uses (GET /2/users/:id/bookmarks on your own id). `count_posts` is a flat
 * per-request fee ($0.005 recent / $0.010 full archive) and returns how many
 * posts match a query WITHOUT reading them, so you can price a
 * `search_posts`/`get_user_tweets` pull first. Reads are
 * DEDUPLICATED within a UTC day: re-reading the same resource (e.g. when paging
 * overlaps) inside 24h is free. Each tool states its cost in its description and
 * reports the actual per-call spend in its `note` field.
 */
import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/** Base host for the X API v2. */
const BASE_URL = 'https://api.x.com';

/** OAuth 2.0 token endpoint (refresh-token grant for the user-context flow). */
const TOKEN_URL = `${BASE_URL}/2/oauth2/token`;

/**
 * Shown when the user-context authorization can no longer be refreshed (the
 * refresh token was revoked, expired, or rotated out of sync). Non-retryable —
 * retrying with the same dead token cannot succeed. Never embeds token values.
 */
const REAUTH_MESSAGE =
  'Your X bookmark authorization has expired — re-run the authorize step ' +
  '(scripts/x-authorize.mjs) and update X_OAUTH_REFRESH_TOKEN.';

/**
 * Default tweet fields requested on every tweet read. `note_tweet` carries the
 * untruncated body of long (>280-char) posts; `entities` lets us expand t.co
 * links; `attachments` ties a post to its media keys.
 */
const TWEET_FIELDS = 'created_at,public_metrics,entities,referenced_tweets,note_tweet,attachments';
/** Expansion + fields that surface a post's attached media (photos/videos/gifs). */
const MEDIA_EXPANSION = 'attachments.media_keys';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';
/** Minimal user fields needed to join an author onto a tweet. */
const USER_FIELDS_BASIC = 'name,username,verified';
/** Rich user fields for a full profile lookup. */
const USER_FIELDS_PROFILE =
  'description,public_metrics,verified,created_at,location,profile_image_url';

/** The post types a caller can choose to include on a read. */
const POST_TYPES = ['posts', 'reposts', 'replies'] as const;
type PostType = (typeof POST_TYPES)[number];

/**
 * Map an `include` selection to X's timeline `exclude` param. The
 * `/2/users/:id/tweets` endpoint can only DROP replies and retweets — it can
 * never drop originals — so 'posts' is implicit: any selection returns originals
 * PLUS the extra types chosen. Returns undefined when nothing is excluded.
 */
function includeToExclude(include: readonly PostType[]): string | undefined {
  const parts: string[] = [];
  if (!include.includes('replies')) parts.push('replies');
  if (!include.includes('reposts')) parts.push('retweets');
  return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Translate a `post_types` selection into X search operators. Replies/reposts not
 * selected are dropped with `-is:reply` / `-is:retweet`; when originals are NOT
 * selected, a positive requirement keeps only the chosen non-original type(s).
 * Returns '' when all three (or none) are selected — i.e. no filtering needed.
 */
function postTypeOperators(types: readonly PostType[]): string {
  if (types.length === 0 || types.length === POST_TYPES.length) return '';
  const parts: string[] = [];
  if (!types.includes('replies')) parts.push('-is:reply');
  if (!types.includes('reposts')) parts.push('-is:retweet');
  if (!types.includes('posts')) {
    const wantReplies = types.includes('replies');
    const wantReposts = types.includes('reposts');
    if (wantReplies && wantReposts) parts.push('(is:reply OR is:retweet)');
    else if (wantReplies) parts.push('is:reply');
    else if (wantReposts) parts.push('is:retweet');
  }
  return parts.join(' ');
}

/** Append post-type operators to a base query, if any types were given. */
function applyPostTypes(query: string, types: readonly PostType[] | undefined): string {
  if (!types || types.length === 0) return query;
  const ops = postTypeOperators(types);
  return ops ? `${query} ${ops}` : query;
}

/** X's official per-resource read rates (pay-per-use): https://docs.x.com/x-api/getting-started/pricing */
const POST_READ_USD = 0.005;
const USER_READ_USD = 0.01;
/** "Owned read" — your OWN data via user-context (bookmarks, likes): $0.001/resource. */
const OWNED_READ_USD = 0.001;

/**
 * The metered cost of a call, surfaced to the agent/user in the `note` field:
 * the official per-resource rates plus this call's resource count and dollar
 * total. `unit` is 'post' (other people's posts, $0.005) or 'bookmark' (your own
 * data — an "owned read" at the discounted $0.001 rate).
 */
function costNote(
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

/** Coerce to a finite number, else null. */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Coerce to a non-empty string, else null. */
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pull a human-readable reason out of X's error shapes, or ''. */
function parseXError(body: string): string {
  try {
    const j = JSON.parse(body) as {
      errors?: { detail?: unknown; message?: unknown; title?: unknown }[];
      detail?: unknown;
      title?: unknown;
    };
    const e = Array.isArray(j.errors) ? j.errors[0] : undefined;
    if (e) {
      const m = e.detail ?? e.message ?? e.title;
      if (typeof m === 'string') return m;
    }
    if (typeof j.detail === 'string') return j.detail;
    if (typeof j.title === 'string') return j.title;
  } catch {
    return body.slice(0, 120);
  }
  return '';
}

/**
 * Map an X HTTP error status to a tool error: 401/403 → bad token, 404 → not
 * found, 429 → rate limit, other 4xx → surface X's reason. Returns undefined for
 * anything else (5xx) so the SDK's default retryable mapping applies.
 */
function mapXHttpError(
  status: number,
  body: string,
  unauthorizedMessage?: string,
): ToolError | undefined {
  const reason = parseXError(body);
  if (status === 401 || status === 403) {
    return new ToolError(
      unauthorizedMessage ??
        "X_BEARER_TOKEN is missing or unauthorized — check your app's Bearer Token and access level.",
      { retryable: false },
    );
  }
  if (status === 404) {
    return new ToolError(`X resource not found${reason ? `: ${reason}` : '.'}`, {
      retryable: false,
    });
  }
  if (status === 429) {
    return new ToolError('X rate limit hit; try again shortly.', { retryable: true });
  }
  if (status >= 400 && status < 500) {
    return new ToolError(`X rejected the request${reason ? `: ${reason}` : '.'}`, {
      retryable: false,
    });
  }
  return undefined;
}

/** Options for {@link xGet}. */
interface XGetOptions {
  /** Bearer to attach instead of the app-only `X_BEARER_TOKEN` (user-context flow). */
  bearer?: string;
  /** Override the 401/403 message (e.g. the bookmark re-authorize hint). */
  unauthorizedMessage?: string;
}

/**
 * GET an X API endpoint with a Bearer attached, mapping X's HTTP statuses to
 * tool errors: 401/403 → bad token (non-retryable), 404 → not found
 * (non-retryable), 429 → rate limit (retryable), other 4xx → surface X's reason
 * (non-retryable). 5xx falls through to the SDK's default (retryable) mapping.
 *
 * By default the app-only `X_BEARER_TOKEN` is used; pass `opts.bearer` to send a
 * user-context access token instead (for `get_bookmarks`).
 */
async function xGet(
  path: string,
  params: URLSearchParams,
  ctx: ToolContext,
  opts: XGetOptions = {},
): Promise<Record<string, unknown>> {
  const token = opts.bearer ?? (await ctx.requireSecret('X_BEARER_TOKEN'));
  const qs = params.toString();
  const url = qs ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
  const parsed = await ctx.fetchJson(url, {
    init: { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
    errorMap(res, body) {
      return mapXHttpError(res.status, body, opts.unauthorizedMessage);
    },
  });
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError('X returned malformed data; try again shortly.', { retryable: true });
  }
  return parsed as Record<string, unknown>;
}

/** A joined-in author for a tweet. */
interface XUser {
  username: string | null;
  name: string | null;
  verified: boolean | null;
}

/** Index `includes.users` by id for author joins. */
function indexUsers(includes: unknown): Map<string, XUser> {
  const map = new Map<string, XUser>();
  const arr =
    includes &&
    typeof includes === 'object' &&
    Array.isArray((includes as { users?: unknown }).users)
      ? (includes as { users: unknown[] }).users
      : [];
  for (const u of arr) {
    const o = u as Record<string, unknown>;
    if (typeof o.id === 'string') {
      map.set(o.id, {
        username: strOrNull(o.username),
        name: strOrNull(o.name),
        verified: typeof o.verified === 'boolean' ? o.verified : null,
      });
    }
  }
  return map;
}

/** Index `includes.tweets` (referenced/quoted/replied-to) by id. */
function indexTweets(includes: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const arr =
    includes &&
    typeof includes === 'object' &&
    Array.isArray((includes as { tweets?: unknown }).tweets)
      ? (includes as { tweets: unknown[] }).tweets
      : [];
  for (const t of arr) {
    const o = t as Record<string, unknown>;
    if (typeof o.id === 'string') map.set(o.id, o);
  }
  return map;
}

/** A joined-in media attachment for a tweet. */
interface XMedia {
  type: string;
  url?: string;
  alt?: string;
}

/** Index `includes.media` by `media_key` so attachments can be joined onto tweets. */
function indexMedia(includes: unknown): Map<string, XMedia> {
  const map = new Map<string, XMedia>();
  const arr =
    includes &&
    typeof includes === 'object' &&
    Array.isArray((includes as { media?: unknown }).media)
      ? (includes as { media: unknown[] }).media
      : [];
  for (const m of arr) {
    const o = m as Record<string, unknown>;
    const key = strOrNull(o.media_key);
    const type = strOrNull(o.type);
    if (!key || !type) continue;
    const entry: XMedia = { type };
    // Photos carry `url`; videos/gifs carry `preview_image_url` instead.
    const url = strOrNull(o.url) ?? strOrNull(o.preview_image_url);
    if (url) entry.url = url;
    const alt = strOrNull(o.alt_text);
    if (alt) entry.alt = alt;
    map.set(key, entry);
  }
  return map;
}

/** A `{ urls: [{ url, expanded_url }] }` entities bag (from a tweet or note_tweet). */
interface XEntities {
  urls?: { url?: unknown; expanded_url?: unknown }[];
}

/**
 * Replace each shortened `t.co` URL in `text` with its real destination, using
 * the matching `entities.urls[]` entry. Only exact `url` matches are replaced,
 * and an entry without an `expanded_url` is skipped.
 */
function expandTcoLinks(text: string, entities: unknown): string {
  const urls =
    entities && typeof entities === 'object' && Array.isArray((entities as XEntities).urls)
      ? (entities as { urls: unknown[] }).urls
      : [];
  let out = text;
  for (const u of urls) {
    const o = u as Record<string, unknown>;
    const shortUrl = strOrNull(o.url);
    const expanded = strOrNull(o.expanded_url);
    if (shortUrl && expanded) out = out.replaceAll(shortUrl, expanded);
  }
  return out;
}

/** A clean, mapped tweet. */
interface MappedTweet {
  id: string;
  text: string;
  url: string | null;
  author: string | null;
  authorName: string | null;
  createdAt: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  media?: XMedia[];
}

/** Resolve a tweet's `attachments.media_keys` against the includes media index. */
function resolveMedia(raw: Record<string, unknown>, media: Map<string, XMedia>): XMedia[] {
  const attachments = raw.attachments;
  const keys =
    attachments &&
    typeof attachments === 'object' &&
    Array.isArray((attachments as { media_keys?: unknown }).media_keys)
      ? (attachments as { media_keys: unknown[] }).media_keys
      : [];
  const out: XMedia[] = [];
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    const m = media.get(k);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Map a raw X tweet to a clean shape, joining its author from `users` and any
 * attached media from `media`. Long posts use the untruncated `note_tweet.text`,
 * and `t.co` links are expanded to their real destinations.
 */
function mapTweet(
  raw: Record<string, unknown>,
  users: Map<string, XUser>,
  media: Map<string, XMedia> = new Map(),
): MappedTweet {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const authorId = typeof raw.author_id === 'string' ? raw.author_id : null;
  const user = authorId ? users.get(authorId) : undefined;
  const handle = user?.username ?? null;
  const pm = (raw.public_metrics ?? {}) as Record<string, unknown>;
  const url = id
    ? handle
      ? `https://x.com/${handle}/status/${id}`
      : `https://x.com/i/status/${id}`
    : null;

  // Prefer the untruncated long-form body when present, expanding its t.co links
  // against the matching entities bag (note_tweet's own when long-form is used).
  const noteTweet = raw.note_tweet as { text?: unknown; entities?: unknown } | undefined;
  const noteText = noteTweet ? strOrNull(noteTweet.text) : null;
  const rawText = noteText ?? (typeof raw.text === 'string' ? raw.text : '');
  const entities = noteText ? noteTweet?.entities : raw.entities;
  const text = expandTcoLinks(rawText, entities);

  const mapped: MappedTweet = {
    id,
    text,
    url,
    author: handle ? `@${handle}` : null,
    authorName: user?.name ?? null,
    createdAt: strOrNull(raw.created_at),
    likes: numOrNull(pm.like_count),
    reposts: numOrNull(pm.retweet_count),
    replies: numOrNull(pm.reply_count),
    quotes: numOrNull(pm.quote_count),
  };
  const mediaItems = resolveMedia(raw, media);
  if (mediaItems.length > 0) mapped.media = mediaItems;
  return mapped;
}

/** A referenced (quoted/replied-to) tweet, tagged with its reference type. */
type ReferencedTweet = MappedTweet & { type: string | null };

/** An empty referenced-tweet placeholder for a ref X did not expand in the payload. */
function placeholderReference(refId: string): MappedTweet {
  return {
    id: refId,
    text: '',
    url: refId ? `https://x.com/i/status/${refId}` : null,
    author: null,
    authorName: null,
    createdAt: null,
    likes: null,
    reposts: null,
    replies: null,
    quotes: null,
  };
}

/**
 * Resolve a tweet's `referenced_tweets[]` against the includes index, mapping
 * each to a clean tweet (or a placeholder when X didn't expand it), tagged with
 * its reference type.
 */
function mapReferencedTweets(
  rawTweet: Record<string, unknown>,
  tweetsIndex: Map<string, Record<string, unknown>>,
  users: Map<string, XUser>,
  media: Map<string, XMedia>,
): ReferencedTweet[] {
  if (!Array.isArray(rawTweet.referenced_tweets)) return [];
  const referenced: ReferencedTweet[] = [];
  for (const ref of rawTweet.referenced_tweets) {
    const ro = ref as Record<string, unknown>;
    const refId = typeof ro.id === 'string' ? ro.id : '';
    const refRaw = refId ? tweetsIndex.get(refId) : undefined;
    const mapped = refRaw ? mapTweet(refRaw, users, media) : placeholderReference(refId);
    referenced.push({ type: strOrNull(ro.type), ...mapped });
  }
  return referenced;
}

/** A resolved user profile. */
interface MappedProfile {
  id: string;
  name: string | null;
  username: string | null;
  url: string | null;
  bio: string | null;
  followers: number | null;
  following: number | null;
  tweetCount: number | null;
  verified: boolean | null;
  createdAt: string | null;
  location: string | null;
  profileImageUrl: string | null;
}

/** Map a raw X user object to a clean profile. */
function mapProfile(raw: Record<string, unknown>): MappedProfile {
  const pm = (raw.public_metrics ?? {}) as Record<string, unknown>;
  const username = strOrNull(raw.username);
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: strOrNull(raw.name),
    username,
    url: username ? `https://x.com/${username}` : null,
    bio: strOrNull(raw.description),
    followers: numOrNull(pm.followers_count),
    following: numOrNull(pm.following_count),
    tweetCount: numOrNull(pm.tweet_count),
    verified: typeof raw.verified === 'boolean' ? raw.verified : null,
    createdAt: strOrNull(raw.created_at),
    location: strOrNull(raw.location),
    profileImageUrl: strOrNull(raw.profile_image_url),
  };
}

/** Strip a leading @ (and surrounding whitespace) from a handle. */
function cleanUsername(input: string): string {
  return input.trim().replace(/^@+/, '');
}

/** Parse a raw tweet id or an x.com/twitter.com status URL into a numeric id. */
function parseTweetId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const statusMatch = /status(?:es)?\/(\d+)/.exec(trimmed);
  if (statusMatch?.[1]) return statusMatch[1];
  const numericMatch = /(\d{5,})/.exec(trimmed);
  return numericMatch?.[1] ?? null;
}

/** One-line, truncated preview of a tweet body for the human-readable summary. */
function snippet(text: string, max = 140): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A single human-readable summary line for a mapped tweet. */
function tweetLine(t: MappedTweet): string {
  const metrics = `${t.likes ?? 0} likes, ${t.reposts ?? 0} reposts, ${t.replies ?? 0} replies`;
  const when = t.createdAt ? `[${t.createdAt}] ` : '';
  return `  ${when}${snippet(t.text)} (${metrics})`;
}

/**
 * Resolve a username → raw X user object via `/2/users/by/username/:username`.
 * X can answer 200 with a `{ errors: [...] }` partial-error and no `data`; treat
 * a missing `data` as not-found.
 */
async function resolveUser(
  username: string,
  fields: string,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ 'user.fields': fields });
  const body = await xGet(`/2/users/by/username/${encodeURIComponent(username)}`, params, ctx);
  const data = body.data;
  if (!data || typeof data !== 'object') {
    throw new ToolError(`X user @${username} not found.`, { retryable: false });
  }
  return data as Record<string, unknown>;
}

/**
 * In-memory user-context auth, scoped to one warm isolate. Holds the freshly
 * minted access token (with its expiry), the LATEST rotated refresh token, and
 * the resolved bookmark owner id. Because X rotates the refresh token on every
 * grant, this cache is what lets repeated `get_bookmarks` calls in the same warm
 * process keep working without re-reading (and invalidating) the stored token.
 * It is process-local and never persisted; token values are never logged.
 */
interface BookmarkAuth {
  accessToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
  /** The most recent refresh token (rotates on every refresh). */
  refreshToken: string;
  /** The bookmark owner's user id, resolved once via `/2/users/me`. */
  userId?: string;
}

let bookmarkAuth: BookmarkAuth | undefined;

/** Re-arm window: refresh a little before the real expiry to avoid edge races. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Reset the module-level user-context cache. Test-only seam. */
export function __resetBookmarkAuth(): void {
  bookmarkAuth = undefined;
}

/**
 * Resolved handle → user-id cache, scoped to one warm isolate. Resolving a
 * handle is a billable user lookup, so `get_user_tweets` caches the id to avoid
 * re-paying on every call for the same person. Keyed by lowercased username.
 */
const userIdCache = new Map<string, string>();

/** Reset the module-level username→id cache. Test-only seam. */
export function __resetUserCache(): void {
  userIdCache.clear();
}

/** The lightweight user object surfaced alongside a timeline. */
interface TimelineUser {
  id: string;
  name: string | null;
  username: string | null;
  url: string | null;
  verified: boolean | null;
}

/**
 * Resolve a handle to its user id plus a display user. The handle→id lookup is a
 * billable user read, so a cached id is reused and returned with
 * `resolvedNow: false`; only a cache miss resolves (and bills) the lookup.
 */
async function resolveTimelineUser(
  username: string,
  ctx: ToolContext,
): Promise<{ userId: string; user: TimelineUser; resolvedNow: boolean }> {
  const cacheKey = username.toLowerCase();
  const cachedId = userIdCache.get(cacheKey);
  if (cachedId) {
    return {
      userId: cachedId,
      user: {
        id: cachedId,
        name: null,
        username,
        url: `https://x.com/${username}`,
        verified: null,
      },
      resolvedNow: false,
    };
  }
  const userRaw = await resolveUser(username, USER_FIELDS_BASIC, ctx);
  const userId = typeof userRaw.id === 'string' ? userRaw.id : '';
  if (userId) userIdCache.set(cacheKey, userId);
  return {
    userId,
    user: {
      id: userId,
      name: strOrNull(userRaw.name),
      username: strOrNull(userRaw.username),
      url: typeof userRaw.username === 'string' ? `https://x.com/${userRaw.username}` : null,
      verified: typeof userRaw.verified === 'boolean' ? userRaw.verified : null,
    },
    resolvedNow: true,
  };
}

/** Read an optional secret, treating "missing"/empty as `undefined`. */
async function optionalSecret(ctx: ToolContext, name: string): Promise<string | undefined> {
  try {
    const value = await ctx.secret(name);
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the refresh-token grant and replace the module cache (including the NEW
 * rotated refresh token). On a 400/401 (invalid_grant / unauthorized) the stored
 * authorization is dead — surface the non-retryable re-authorize hint.
 */
async function refreshUserToken(ctx: ToolContext): Promise<string> {
  const clientId = await ctx.requireSecret('X_OAUTH_CLIENT_ID');
  const refreshToken =
    bookmarkAuth?.refreshToken ?? (await ctx.requireSecret('X_OAUTH_REFRESH_TOKEN'));
  const clientSecret = await optionalSecret(ctx, 'X_OAUTH_CLIENT_SECRET');

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  // Confidential clients additionally authenticate with HTTP Basic.
  if (clientSecret) headers.authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;

  const parsed = await ctx.fetchJson(TOKEN_URL, {
    init: { method: 'POST', headers, body: form.toString() },
    errorMap(res) {
      if (res.status === 400 || res.status === 401) {
        return new ToolError(REAUTH_MESSAGE, { retryable: false });
      }
      return undefined;
    },
  });
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError('X token endpoint returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const body = parsed as Record<string, unknown>;
  const accessToken = strOrNull(body.access_token);
  if (!accessToken) throw new ToolError(REAUTH_MESSAGE, { retryable: false });
  const expiresIn = numOrNull(body.expires_in) ?? 7200;
  // Carry the old refresh token forward only if the response omits a new one.
  const newRefresh = strOrNull(body.refresh_token) ?? refreshToken;

  bookmarkAuth = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: newRefresh,
    userId: bookmarkAuth?.userId,
  };
  return accessToken;
}

/** A valid user-context access token, refreshing through the cache as needed. */
async function getUserAccessToken(ctx: ToolContext): Promise<string> {
  if (bookmarkAuth && bookmarkAuth.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return bookmarkAuth.accessToken;
  }
  return refreshUserToken(ctx);
}

/** Resolve (and cache) the bookmark owner's user id via `/2/users/me`. */
async function getBookmarkOwnerId(ctx: ToolContext, accessToken: string): Promise<string> {
  if (bookmarkAuth?.userId) return bookmarkAuth.userId;
  const body = await xGet('/2/users/me', new URLSearchParams(), ctx, {
    bearer: accessToken,
    unauthorizedMessage: REAUTH_MESSAGE,
  });
  const data = body.data;
  const id = data && typeof data === 'object' ? (data as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ToolError('Could not resolve your X user id for bookmarks.', { retryable: false });
  }
  if (bookmarkAuth) bookmarkAuth.userId = id;
  return id;
}

const tweetShape = z.object({
  id: z.string(),
  text: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string().nullable(),
  likes: z.number().nullable(),
  reposts: z.number().nullable(),
  replies: z.number().nullable(),
  quotes: z.number().nullable(),
  media: z
    .array(z.object({ type: z.string(), url: z.string().optional(), alt: z.string().optional() }))
    .optional(),
});

const profileShape = z.object({
  id: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  url: z.string().nullable(),
  bio: z.string().nullable(),
  followers: z.number().nullable(),
  following: z.number().nullable(),
  tweetCount: z.number().nullable(),
  verified: z.boolean().nullable(),
  createdAt: z.string().nullable(),
  location: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
});

export default defineMcpServer({
  tools: [
    {
      name: 'get_user_tweets',
      title: 'X: Get a user’s recent posts',
      description:
        'Fetch a person’s recent posts by handle. Resolves the @handle to an id, ' +
        'then returns their timeline with clean text, a canonical x.com URL, author, ' +
        'created_at, like/repost/reply counts, and any attached media. Choose which ' +
        'post types you want with `include` (default: originals only); page newer ' +
        'with `since_id` or older with `pagination_token` (surfaced as `next_token`). ' +
        'NOTE: this endpoint always returns originals and can only ADD reposts/replies ' +
        '— it can’t return replies-only or reposts-only (use `search_posts` with ' +
        '`post_types` for that, e.g. older than 7 days too). Long posts return full ' +
        'text and t.co links are expanded. Cost: $0.010 for the one-time handle→id ' +
        'lookup (cached per warm isolate) + $0.005 per post returned — so a call bills ' +
        'about $0.010 + max_results×$0.005; size `max_results` accordingly.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        username: z.string().min(1).describe('X handle, with or without a leading @.'),
        max_results: z.number().int().min(5).max(100).default(10).describe('Max posts (5–100).'),
        include: z
          .array(z.enum(POST_TYPES))
          .default(['posts'])
          .describe(
            'Which post types to include: any of "posts" (originals), "reposts", ' +
              '"replies". Default ["posts"] = originals only. Originals are always ' +
              'returned; selecting reposts/replies adds them.',
          ),
        since_id: z
          .string()
          .optional()
          .describe('Only return posts newer than this tweet id (for paging forward).'),
        pagination_token: z
          .string()
          .optional()
          .describe('Page through older posts using a prior call’s `next_token`.'),
      }),
      output: z.object({
        user: z.object({
          id: z.string(),
          name: z.string().nullable(),
          username: z.string().nullable(),
          url: z.string().nullable(),
          verified: z.boolean().nullable(),
        }),
        count: z.number(),
        tweets: z.array(tweetShape),
        next_token: z.string().optional(),
        note: z.string(),
      }),
      async handler(args, ctx) {
        const username = cleanUsername(args.username);
        if (!username) throw new ToolError('Provide a non-empty username.', { retryable: false });
        ctx.log('get_user_tweets', {
          username,
          max_results: args.max_results,
          include: args.include,
        });
        // Resolving a handle is a billable user lookup; reuse a cached id when we
        // have one (and only bill for it on a cache miss).
        const { userId, user, resolvedNow } = await resolveTimelineUser(username, ctx);

        const params = new URLSearchParams({
          max_results: String(args.max_results),
          'tweet.fields': TWEET_FIELDS,
          expansions: `author_id,${MEDIA_EXPANSION}`,
          'user.fields': USER_FIELDS_BASIC,
          'media.fields': MEDIA_FIELDS,
        });
        const exclude = includeToExclude(args.include);
        if (exclude) params.set('exclude', exclude);
        if (args.since_id) params.set('since_id', args.since_id);
        if (args.pagination_token) params.set('pagination_token', args.pagination_token);

        const body = await xGet(`/2/users/${encodeURIComponent(userId)}/tweets`, params, ctx);
        const users = indexUsers(body.includes);
        const media = indexMedia(body.includes);
        const rawTweets = Array.isArray(body.data) ? body.data : [];
        const tweets = rawTweets.map((t) => mapTweet(t as Record<string, unknown>, users, media));
        const meta = (body.meta ?? {}) as Record<string, unknown>;
        const nextToken = strOrNull(meta.next_token) ?? undefined;
        const note = costNote(tweets.length, resolvedNow ? 1 : 0);

        if (tweets.length === 0) {
          return {
            text: `@${username} has no recent posts matching the filter.\n${note}`,
            structured: { user, count: 0, tweets: [], next_token: nextToken, note },
          };
        }
        return {
          text:
            `@${username} — ${tweets.length} recent post(s):\n` +
            `${tweets.map((t) => tweetLine(t)).join('\n')}\n${note}`,
          structured: { user, count: tweets.length, tweets, next_token: nextToken, note },
        };
      },
    },
    {
      name: 'get_tweet',
      title: 'X: Get one post',
      description:
        'Expand one post by raw tweet id OR an x.com/twitter.com status URL (the ' +
        'trailing numeric id is parsed out). Returns the post with author, URL, ' +
        'created_at and metrics; with `expand_referenced` (default true) it also ' +
        'resolves any quoted or replied-to post’s text. Cost: $0.005 for the post + ' +
        '$0.005 per referenced (quoted/replied) post resolved.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id_or_url: z
          .string()
          .min(1)
          .describe('A tweet id (e.g. "1899…") or an x.com/twitter.com status URL.'),
        expand_referenced: z
          .boolean()
          .default(true)
          .describe('Resolve quoted/replied-to posts referenced by this one.'),
      }),
      output: z.object({
        tweet: tweetShape,
        referenced: z.array(tweetShape.extend({ type: z.string().nullable() })),
        note: z.string(),
      }),
      async handler(args, ctx) {
        const id = parseTweetId(args.id_or_url);
        if (!id) {
          throw new ToolError(`Could not parse a tweet id from "${args.id_or_url}".`, {
            retryable: false,
          });
        }
        ctx.log('get_tweet', { id, expand_referenced: args.expand_referenced });
        const params = new URLSearchParams({
          ids: id,
          'tweet.fields': `${TWEET_FIELDS},conversation_id`,
          expansions: `author_id,referenced_tweets.id,referenced_tweets.id.author_id,${MEDIA_EXPANSION}`,
          'user.fields': USER_FIELDS_BASIC,
          'media.fields': MEDIA_FIELDS,
        });
        const body = await xGet('/2/tweets', params, ctx);
        const rawTweets = Array.isArray(body.data) ? body.data : [];
        if (rawTweets.length === 0) {
          throw new ToolError(`Tweet ${id} not found (or not accessible).`, { retryable: false });
        }
        const users = indexUsers(body.includes);
        const media = indexMedia(body.includes);
        const tweetsIndex = indexTweets(body.includes);
        const rawTweet = rawTweets[0] as Record<string, unknown>;
        const tweet = mapTweet(rawTweet, users, media);

        const referenced = args.expand_referenced
          ? mapReferencedTweets(rawTweet, tweetsIndex, users, media)
          : [];

        const note = costNote(1 + referenced.length, 0);
        const refLines = referenced
          .map((r) => `  ↳ ${r.type ?? 'ref'}: ${snippet(r.text)}`)
          .join('\n');
        return {
          text:
            `${tweet.author ?? '?'} ${tweet.createdAt ? `[${tweet.createdAt}] ` : ''}${snippet(tweet.text)}\n` +
            `  ${tweet.likes ?? 0} likes, ${tweet.reposts ?? 0} reposts, ${tweet.replies ?? 0} replies` +
            `${refLines ? `\n${refLines}` : ''}\n${note}`,
          structured: { tweet, referenced, note },
        };
      },
    },
    {
      name: 'get_post_replies',
      title: 'X: Get a post’s reply thread',
      description:
        'Given a post (raw id or x.com/twitter.com status URL), return the conversation ' +
        'under it — what people are saying in reply. Resolves the post’s conversation ' +
        'id first (so a reply’s URL still maps to its thread), surfaces the post you ' +
        'passed as `root`, and returns the thread’s replies (the author’s own ' +
        'follow-ups included — the whole thread). `scope`: recent = last 7 days ' +
        '(cheapest); archive = full history back to 2006 — use for posts older than 7 ' +
        'days. Page with `pagination_token`. Cost: $0.005 for the root lookup + $0.005 ' +
        'per reply returned.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id_or_url: z
          .string()
          .min(1)
          .describe('A tweet id (e.g. "1899…") or an x.com/twitter.com status URL.'),
        scope: z
          .enum(['recent', 'archive'])
          .default('recent')
          .describe(
            'recent = last 7 days (cheapest); archive = full history back to 2006 — ' +
              'use for posts older than 7 days.',
          ),
        max_results: z
          .number()
          .int()
          .min(10)
          .max(100)
          .default(20)
          .describe('Max replies to return (10–100).'),
        pagination_token: z
          .string()
          .optional()
          .describe('Page through more replies using a prior call’s `next_token`.'),
      }),
      output: z.object({
        conversation_id: z.string(),
        root: tweetShape.nullable(),
        count: z.number(),
        replies: z.array(tweetShape),
        next_token: z.string().optional(),
        note: z.string(),
      }),
      async handler(args, ctx) {
        const id = parseTweetId(args.id_or_url);
        if (!id) {
          throw new ToolError(`Could not parse a tweet id from "${args.id_or_url}".`, {
            retryable: false,
          });
        }
        ctx.log('get_post_replies', { id, scope: args.scope, max_results: args.max_results });

        // 1) Resolve the conversation id (and capture the post itself) so that a
        //    reply's URL still maps to its whole thread.
        const rootParams = new URLSearchParams({
          ids: id,
          'tweet.fields': `${TWEET_FIELDS},conversation_id`,
          expansions: `author_id,${MEDIA_EXPANSION}`,
          'user.fields': USER_FIELDS_BASIC,
          'media.fields': MEDIA_FIELDS,
        });
        const rootBody = await xGet('/2/tweets', rootParams, ctx);
        const rootRaw = Array.isArray(rootBody.data) ? rootBody.data : [];
        if (rootRaw.length === 0) {
          throw new ToolError(`Tweet ${id} not found (or not accessible).`, { retryable: false });
        }
        const rootTweetRaw = rootRaw[0] as Record<string, unknown>;
        const root = mapTweet(
          rootTweetRaw,
          indexUsers(rootBody.includes),
          indexMedia(rootBody.includes),
        );
        const conversationId = strOrNull(rootTweetRaw.conversation_id) ?? id;

        // 2) Pull the thread by conversation id (recent vs full-archive search).
        const params = new URLSearchParams({
          query: `conversation_id:${conversationId}`,
          max_results: String(args.max_results),
          'tweet.fields': TWEET_FIELDS,
          expansions: `author_id,${MEDIA_EXPANSION}`,
          'user.fields': USER_FIELDS_BASIC,
          'media.fields': MEDIA_FIELDS,
        });
        if (args.pagination_token) params.set('pagination_token', args.pagination_token);
        const path = args.scope === 'archive' ? '/2/tweets/search/all' : '/2/tweets/search/recent';
        const body = await xGet(path, params, ctx);
        const users = indexUsers(body.includes);
        const media = indexMedia(body.includes);
        const rawTweets = Array.isArray(body.data) ? body.data : [];
        // Drop the post we already surfaced as `root` so it isn't duplicated.
        const replies = rawTweets
          .map((t) => mapTweet(t as Record<string, unknown>, users, media))
          .filter((t) => t.id !== root.id);
        const meta = (body.meta ?? {}) as Record<string, unknown>;
        const nextToken = strOrNull(meta.next_token) ?? undefined;
        // Root lookup ($0.005) + each reply read ($0.005).
        const note = costNote(1 + replies.length, 0);

        if (replies.length === 0) {
          return {
            text: `No replies found for ${root.url ?? id} (conversation ${conversationId}).\n${note}`,
            structured: {
              conversation_id: conversationId,
              root,
              count: 0,
              replies: [],
              next_token: nextToken,
              note,
            },
          };
        }
        return {
          text:
            `${root.author ?? '?'} ${root.createdAt ? `[${root.createdAt}] ` : ''}${snippet(root.text)}\n` +
            `  ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} in the thread:\n` +
            `${replies.map((t) => `${t.author ?? '?'}:${tweetLine(t)}`).join('\n')}\n${note}`,
          structured: {
            conversation_id: conversationId,
            root,
            count: replies.length,
            replies,
            next_token: nextToken,
            note,
          },
        };
      },
    },
    {
      name: 'search_posts',
      title: 'X: Search posts (recent or full archive)',
      description:
        'Search posts using X search operators (e.g. "from:nasa", ' +
        '"#hurricane lang:en -is:retweet"). `scope` controls recency vs archive: ' +
        'recent = last 7 days (cheapest); archive = full history back to 2006 — use ' +
        'for anything older than 7 days. Returns matching posts with author, URL, ' +
        'created_at, metrics and any attached media. Optionally bound by ISO ' +
        'start/end time and order by recency or relevancy; page with ' +
        '`pagination_token` (surfaced as `next_token`). Use `post_types` to filter ' +
        'by originals/reposts/replies without hand-writing is:/-is: operators. Cost: ' +
        '$0.005 per post returned (no user lookup) — i.e. max_results×$0.005, either scope.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('X search query (supports search operators).'),
        scope: z
          .enum(['recent', 'archive'])
          .default('recent')
          .describe(
            'recent = last 7 days (cheapest); archive = full history back to 2006 — ' +
              'use for anything older than 7 days.',
          ),
        post_types: z
          .array(z.enum(POST_TYPES))
          .optional()
          .describe(
            'Optional filter by post type: any of "posts" (originals), "reposts", ' +
              '"replies". Appends the matching is:/-is: operators to `query` (e.g. ' +
              '["posts"] → originals only; ["replies"] → replies only). Omit for no filter.',
          ),
        max_results: z.number().int().min(10).max(100).default(10).describe('Max posts (10–100).'),
        start_time: z
          .string()
          .optional()
          .describe('Oldest post timestamp, ISO 8601 (e.g. 2026-06-20T00:00:00Z).'),
        end_time: z
          .string()
          .optional()
          .describe('Newest post timestamp, ISO 8601 (e.g. 2026-06-27T00:00:00Z).'),
        sort_order: z
          .enum(['recency', 'relevancy'])
          .optional()
          .describe('Order results by recency (default) or relevancy.'),
        pagination_token: z
          .string()
          .optional()
          .describe('Page through more results using a prior call’s `next_token`.'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        tweets: z.array(tweetShape),
        next_token: z.string().optional(),
        note: z.string(),
      }),
      async handler(args, ctx) {
        const query = applyPostTypes(args.query, args.post_types);
        ctx.log('search_posts', {
          query,
          scope: args.scope,
          max_results: args.max_results,
        });
        const params = new URLSearchParams({
          query,
          max_results: String(args.max_results),
          'tweet.fields': TWEET_FIELDS,
          expansions: `author_id,${MEDIA_EXPANSION}`,
          'user.fields': USER_FIELDS_BASIC,
          'media.fields': MEDIA_FIELDS,
        });
        if (args.start_time) params.set('start_time', args.start_time);
        if (args.end_time) params.set('end_time', args.end_time);
        if (args.sort_order) params.set('sort_order', args.sort_order);
        if (args.pagination_token) params.set('pagination_token', args.pagination_token);

        const path = args.scope === 'archive' ? '/2/tweets/search/all' : '/2/tweets/search/recent';
        const body = await xGet(path, params, ctx);
        const users = indexUsers(body.includes);
        const media = indexMedia(body.includes);
        const rawTweets = Array.isArray(body.data) ? body.data : [];
        const tweets = rawTweets.map((t) => mapTweet(t as Record<string, unknown>, users, media));
        const meta = (body.meta ?? {}) as Record<string, unknown>;
        const nextToken = strOrNull(meta.next_token) ?? undefined;
        const note = costNote(tweets.length, 0);

        if (tweets.length === 0) {
          return {
            text: `No recent posts for "${query}".\n${note}`,
            structured: { query, count: 0, tweets: [], next_token: nextToken, note },
          };
        }
        return {
          text:
            `${tweets.length} recent post(s) for "${query}":\n` +
            `${tweets.map((t) => `${t.author ?? '?'}:${tweetLine(t)}`).join('\n')}\n${note}`,
          structured: {
            query,
            count: tweets.length,
            tweets,
            next_token: nextToken,
            note,
          },
        };
      },
    },
    {
      name: 'count_posts',
      title: 'X: Count posts (price a search before pulling)',
      description:
        'Count how many posts match an X query WITHOUT reading the posts — use it to ' +
        'price a `search_posts`/`get_user_tweets` pull before you spend. `scope` ' +
        'controls the window: recent = last 7 days; archive = full history back to ' +
        '2006. Returns the total plus a time series by day/hour/minute. Cost: a FLAT ' +
        'per-request fee regardless of the total — $0.005/request for recent ' +
        '(Counts: Recent), $0.010/request for archive (Counts: All) — versus $0.005 ' +
        'PER post to actually read them, so counting is far cheaper than pulling. E.g. ' +
        'count "from:bcherny" → ~25 posts this week, so a full pull would cost ~$0.125. ' +
        'Pass `post_types` (same as `search_posts`) to price a type-filtered pull.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('X search query (supports search operators).'),
        scope: z
          .enum(['recent', 'archive'])
          .default('recent')
          .describe(
            'recent = last 7 days (cheapest); archive = full history back to 2006 — ' +
              'use for anything older than 7 days.',
          ),
        post_types: z
          .array(z.enum(POST_TYPES))
          .optional()
          .describe(
            'Optional filter by post type: any of "posts" (originals), "reposts", ' +
              '"replies". Appends the same is:/-is: operators as `search_posts`, so a ' +
              'count here prices a matching typed pull. Omit for no filter.',
          ),
        granularity: z
          .enum(['minute', 'hour', 'day'])
          .default('day')
          .describe('Time-bucket size for the series (default: day).'),
        start_time: z
          .string()
          .optional()
          .describe('Oldest timestamp, ISO 8601 (recent scope: within the last 7 days).'),
        end_time: z.string().optional().describe('Newest timestamp, ISO 8601.'),
      }),
      output: z.object({
        query: z.string(),
        total: z.number(),
        granularity: z.string(),
        buckets: z.array(
          z.object({
            start: z.string().nullable(),
            end: z.string().nullable(),
            count: z.number(),
          }),
        ),
        note: z.string(),
      }),
      async handler(args, ctx) {
        const query = applyPostTypes(args.query, args.post_types);
        ctx.log('count_posts', {
          query,
          scope: args.scope,
          granularity: args.granularity,
        });
        const params = new URLSearchParams({
          query,
          granularity: args.granularity,
        });
        if (args.start_time) params.set('start_time', args.start_time);
        if (args.end_time) params.set('end_time', args.end_time);

        const path = args.scope === 'archive' ? '/2/tweets/counts/all' : '/2/tweets/counts/recent';
        const body = await xGet(path, params, ctx);
        const rawBuckets = Array.isArray(body.data) ? body.data : [];
        const buckets = rawBuckets.map((b) => {
          const o = b as Record<string, unknown>;
          return {
            start: strOrNull(o.start),
            end: strOrNull(o.end),
            count: numOrNull(o.tweet_count) ?? 0,
          };
        });
        const meta = (body.meta ?? {}) as Record<string, unknown>;
        const total =
          numOrNull(meta.total_tweet_count) ?? buckets.reduce((sum, b) => sum + b.count, 0);
        const estPull = (total * POST_READ_USD).toFixed(3);
        const countFee = args.scope === 'archive' ? 0.01 : 0.005;
        const countLabel = args.scope === 'archive' ? 'Counts: All' : 'Counts: Recent';
        // Describe the window honestly: an explicit date range, else the scope default.
        const windowLabel =
          args.start_time || args.end_time
            ? `between ${args.start_time ?? 'the start'} and ${args.end_time ?? 'now'}`
            : args.scope === 'archive'
              ? 'across the full archive'
              : 'in the last 7 days';
        const note =
          `${countLabel} — a flat $${countFee.toFixed(3)} per request (the count itself ` +
          `is not billed per result). Reading these ${total} posts would cost ≈ ` +
          `$${estPull} ($0.005/post).`;
        return {
          text:
            `"${query}" — ${total} post(s) ${windowLabel}. ` +
            `Reading them all would cost ≈ $${estPull}.\n${note}`,
          structured: {
            query,
            total,
            granularity: args.granularity,
            buckets,
            note,
          },
        };
      },
    },
    {
      name: 'resolve_user',
      title: 'X: Resolve a handle to a profile',
      description:
        'Look up an X profile by @handle: id, display name, bio, follower/following/' +
        'post counts, verified flag, account creation date, location, and avatar URL. ' +
        'Useful before get_user_tweets, or to vet an account. Cost: $0.010 (one user read).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        username: z.string().min(1).describe('X handle, with or without a leading @.'),
      }),
      output: profileShape.extend({ note: z.string() }),
      async handler(args, ctx) {
        const username = cleanUsername(args.username);
        if (!username) throw new ToolError('Provide a non-empty username.', { retryable: false });
        ctx.log('resolve_user', { username });
        const raw = await resolveUser(username, USER_FIELDS_PROFILE, ctx);
        const profile = mapProfile(raw);
        const note = costNote(0, 1);
        const counts =
          profile.followers !== null
            ? ` · ${profile.followers} followers, ${profile.tweetCount ?? '?'} posts`
            : '';
        return {
          text:
            `${profile.name ?? username} (@${profile.username ?? username})` +
            `${profile.verified ? ' ✓' : ''}${counts}` +
            `${profile.bio ? `\n  ${snippet(profile.bio)}` : ''}\n${note}`,
          structured: { ...profile, note },
        };
      },
    },
    {
      name: 'get_bookmarks',
      title: 'X: Get your bookmarks',
      description:
        'Fetch YOUR most recent X bookmarks (newest bookmark first). Returns each ' +
        'bookmarked post with clean text, a canonical x.com URL, author, created_at ' +
        'and like/repost/reply counts. X exposes only your ~800 most recent ' +
        'bookmarks; page forward with `pagination_token` (surfaced as `next_token`). ' +
        'The API has no bookmark search, so `query` is an optional client-side ' +
        'case-insensitive substring filter over post text + author. Cost: $0.001 per ' +
        'bookmark returned — an "owned read" (your own data), 5× cheaper than a post ' +
        'read — plus a one-time $0.010 user-id lookup per warm isolate; same-day ' +
        're-reads are free. Requires user-context OAuth (X_OAUTH_CLIENT_ID / ' +
        'X_OAUTH_REFRESH_TOKEN).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        max_results: z
          .number()
          .int()
          .min(10)
          .max(100)
          .default(25)
          .describe('Max bookmarks to read this page (10–100).'),
        pagination_token: z
          .string()
          .optional()
          .describe('Page forward using a prior call’s `next_token`.'),
        query: z
          .string()
          .optional()
          .describe('Optional case-insensitive substring filter over post text + author.'),
      }),
      output: z.object({
        bookmarks: z.array(tweetShape),
        next_token: z.string().optional(),
        note: z.string(),
      }),
      async handler(args, ctx) {
        ctx.log('get_bookmarks', {
          max_results: args.max_results,
          paged: Boolean(args.pagination_token),
          filtered: Boolean(args.query),
        });
        const accessToken = await getUserAccessToken(ctx);
        // The owner-id `/2/users/me` call is a one-time User:Read ($0.010) per warm
        // isolate; bill for it only when we actually resolve it (cache miss).
        const ownerCached = Boolean(bookmarkAuth?.userId);
        const userId = await getBookmarkOwnerId(ctx, accessToken);

        const params = new URLSearchParams({
          max_results: String(args.max_results),
          'tweet.fields': TWEET_FIELDS,
          expansions: `author_id,${MEDIA_EXPANSION}`,
          'user.fields': 'name,username',
          'media.fields': MEDIA_FIELDS,
        });
        if (args.pagination_token) params.set('pagination_token', args.pagination_token);

        const body = await xGet(`/2/users/${encodeURIComponent(userId)}/bookmarks`, params, ctx, {
          bearer: accessToken,
          unauthorizedMessage: REAUTH_MESSAGE,
        });
        const users = indexUsers(body.includes);
        const media = indexMedia(body.includes);
        const rawTweets = Array.isArray(body.data) ? body.data : [];
        const read = rawTweets.length;
        let bookmarks = rawTweets.map((t) => mapTweet(t as Record<string, unknown>, users, media));

        const q = args.query?.trim().toLowerCase();
        if (q) {
          bookmarks = bookmarks.filter(
            (b) =>
              b.text.toLowerCase().includes(q) ||
              (b.author?.toLowerCase().includes(q) ?? false) ||
              (b.authorName?.toLowerCase().includes(q) ?? false),
          );
        }

        const meta = (body.meta ?? {}) as Record<string, unknown>;
        const nextToken = strOrNull(meta.next_token) ?? undefined;
        // Bookmarks are ordinary Posts:Read ($0.005 each); add the one-time
        // user-id lookup ($0.010) only on a cache miss.
        const note = costNote(read, ownerCached ? 0 : 1, 'bookmark');

        if (bookmarks.length === 0) {
          const why = q ? ` matching "${args.query}"` : '';
          return {
            text: `No bookmarks${why}.\n${note}`,
            structured: { bookmarks: [], next_token: nextToken, note },
          };
        }
        return {
          text:
            `${bookmarks.length} bookmark(s):\n` +
            `${bookmarks.map((b) => `${b.author ?? '?'}:${tweetLine(b)}`).join('\n')}\n${note}`,
          structured: { bookmarks, next_token: nextToken, note },
        };
      },
    },
  ],
});
