import type { ToolContext } from '@ontrove/mcp';
import { ToolError } from '@ontrove/mcp';

/**
 * Shared X API v2 plumbing for the x server modules: the API host, the default
 * field/expansion selectors requested on every read, small value-coercion
 * primitives, X's error-shape parsing, and the Bearer-attached `xGet` fetch
 * helper (app-only by default, user-context bearer on request).
 */

/** Base host for the X API v2. */
export const BASE_URL = 'https://api.x.com';

/**
 * Default tweet fields requested on every tweet read. `note_tweet` carries the
 * untruncated body of long (>280-char) posts; `entities` lets us expand t.co
 * links; `attachments` ties a post to its media keys.
 */
export const TWEET_FIELDS =
  'created_at,public_metrics,entities,referenced_tweets,note_tweet,attachments';
/** Expansion + fields that surface a post's attached media (photos/videos/gifs). */
export const MEDIA_EXPANSION = 'attachments.media_keys';
export const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';
/** Minimal user fields needed to join an author onto a tweet. */
export const USER_FIELDS_BASIC = 'name,username,verified';
/** Rich user fields for a full profile lookup. */
export const USER_FIELDS_PROFILE =
  'description,public_metrics,verified,created_at,location,profile_image_url';

/** Coerce to a finite number, else null. */
export function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Coerce to a non-empty string, else null. */
export function strOrNull(value: unknown): string | null {
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
export async function xGet(
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
