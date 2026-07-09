import type { ToolContext } from '@ontrove/mcp';
import { ToolError } from '@ontrove/mcp';
import { numOrNull, strOrNull, USER_FIELDS_BASIC, xGet } from './client.ts';

/**
 * Resolving an X handle to a user: the clean {@link MappedProfile} shape, the
 * `@handle` normalizer, the raw `/2/users/by/username` lookup, and the
 * warm-isolate handle→id cache that lets `get_user_tweets` avoid re-paying the
 * billable id lookup on every call.
 */

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
export function mapProfile(raw: Record<string, unknown>): MappedProfile {
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
export function cleanUsername(input: string): string {
  return input.trim().replace(/^@+/, '');
}

/**
 * Resolve a username → raw X user object via `/2/users/by/username/:username`.
 * X can answer 200 with a `{ errors: [...] }` partial-error and no `data`; treat
 * a missing `data` as not-found.
 */
export async function resolveUser(
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
export async function resolveTimelineUser(
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
