import type { ToolContext } from '@ontrove/mcp';
import { ToolError } from '@ontrove/mcp';
import { BASE_URL, numOrNull, strOrNull, xGet } from './client.ts';

/**
 * The user-context OAuth 2.0 flow that `get_bookmarks` needs (the app-only
 * Bearer cannot read `/2/users/:id/bookmarks`). Holds the refresh-token grant, a
 * warm-isolate cache of the freshly minted access token + rotated refresh token
 * + resolved owner id, and the `/2/users/me` owner-id lookup. Token values are
 * never logged or persisted.
 */

/** OAuth 2.0 token endpoint (refresh-token grant for the user-context flow). */
const TOKEN_URL = `${BASE_URL}/2/oauth2/token`;

/**
 * Shown when the user-context authorization can no longer be refreshed (the
 * refresh token was revoked, expired, or rotated out of sync). Non-retryable —
 * retrying with the same dead token cannot succeed. Never embeds token values.
 */
export const REAUTH_MESSAGE =
  'Your X bookmark authorization has expired — re-run the authorize step ' +
  '(scripts/x-authorize.mjs) and update X_OAUTH_REFRESH_TOKEN.';

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

/** Whether the bookmark owner's id is already cached (so it needn't be re-billed). */
export function bookmarkOwnerCached(): boolean {
  return Boolean(bookmarkAuth?.userId);
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
export async function getUserAccessToken(ctx: ToolContext): Promise<string> {
  if (bookmarkAuth && bookmarkAuth.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return bookmarkAuth.accessToken;
  }
  return refreshUserToken(ctx);
}

/** Resolve (and cache) the bookmark owner's user id via `/2/users/me`. */
export async function getBookmarkOwnerId(ctx: ToolContext, accessToken: string): Promise<string> {
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
