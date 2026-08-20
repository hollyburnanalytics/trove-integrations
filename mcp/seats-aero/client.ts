import type { ToolContext, z } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';

/**
 * Transport and auth for the Seats.aero partner API.
 *
 * Auth is a single header, `Partner-Authorization`. Two credential shapes flow
 * through it and they are **not** interchangeable: a personal Pro API key is
 * sent bare, while an OAuth2 access token (`seats:ota:…`) must carry a `Bearer`
 * prefix and is rejected outright by live search. Getting the prefix wrong is a
 * 401 that looks like a bad key, so it is decided here rather than at each call.
 */

export const BASE = 'https://seats.aero/partnerapi';
export const SECRET = 'SEATS_AERO_API_KEY';

/** OAuth2 access tokens are prefixed with `Bearer`; personal API keys are not. */
export function isAccessToken(key: string): boolean {
  return key.startsWith('seats:ota');
}

/** The `Partner-Authorization` value for whichever credential shape was set. */
export function authorization(key: string): string {
  return isAccessToken(key) ? `Bearer ${key}` : key;
}

/** Resolve the API key, failing with a clear message when it is not set. */
export async function apiKey(ctx: Pick<ToolContext, 'requireSecret'>): Promise<string> {
  return ctx.requireSecret(SECRET);
}

/** `Retry-After` in seconds, when Seats.aero sends one. */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Pull the API's own message out of an error body — far more useful than the
 * status alone, and it arrives in three different shapes:
 *
 * - `/live`: `{"success":false,"error":"unsupported source"}` — a string `error`.
 * - `/search`: `{"error":true,"message":"start_date must be formatted as
 *   YYYY-MM-DD","code":"invalid_start_date"}` — `error` is a **boolean** here, so
 *   reading it as the message loses the only sentence worth showing.
 * - a bad key: the bare string `bad_partner_key`, not JSON at all.
 */
function upstreamMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return trimmed.slice(0, 160) || undefined;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown; code?: unknown };
    const text = [parsed.error, parsed.message].find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    if (!text) return undefined;
    return typeof parsed.code === 'string' && parsed.code ? `${text} (${parsed.code})` : text;
  } catch {
    return trimmed.slice(0, 160);
  }
}

/**
 * The daily budget, read off every response.
 *
 * Seats.aero sends `x-ratelimit-limit`/`-remaining`/`-reset` on success as well
 * as on refusal, so the quota never has to be guessed at — which matters on an
 * API that allows 1,000 calls a day *shared across every app using the key*.
 */
export interface Quota {
  limit?: number;
  remaining?: number;
  /** Seconds until the window resets. */
  resetsIn?: number;
}

function header(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function readQuota(response: Response): Quota | undefined {
  const quota: Quota = {
    limit: header(response, 'x-ratelimit-limit'),
    remaining: header(response, 'x-ratelimit-remaining'),
    resetsIn: header(response, 'x-ratelimit-reset'),
  };
  return quota.limit === undefined && quota.remaining === undefined ? undefined : quota;
}

/** `21418` → `5h 57m`, for telling someone when their budget comes back. */
export function untilReset(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A prose warning when the daily budget is nearly gone.
 *
 * Deliberately a threshold rather than a running commentary: printing "976 left"
 * on every search is noise, but discovering a spent quota by hitting a 429 in
 * the middle of a multi-step plan is worse. The number is always in the
 * structured result for anything that wants to budget precisely.
 */
export function quotaNote(quota: Quota | undefined, threshold = 50): string[] {
  if (quota?.remaining === undefined || quota.remaining > threshold) return [];
  const back = untilReset(quota.resetsIn);
  return [
    `BUDGET: ${quota.remaining} of ${quota.limit ?? 1000} Seats.aero API calls left today${
      back ? `, resetting in ${back}` : ''
    }. The quota is shared across every app using this key.`,
  ];
}

/**
 * Map a non-2xx Seats.aero response to a model-safe ToolError.
 *
 * The 429 mapping is the interesting one. Pro accounts get **1,000 calls per
 * day**, so a rate limit here is usually a spent daily budget, not a burst — and
 * retrying a spent budget is useless. It is therefore reported as retryable only
 * when the API actually sends a `Retry-After`; otherwise the caller is told the
 * quota is the likely cause, rather than being sent back into a loop.
 */
export function seatsError(what: string, response: Response, body: string): ToolError {
  const detail = upstreamMessage(body);
  const suffix = detail ? `: ${detail}` : '';

  if (response.status === 429) {
    // The quota headers ride on the refusal too, so this can say *when* the
    // budget comes back rather than inviting a retry that cannot succeed.
    const quota = readQuota(response);
    const after = retryAfterSeconds(response);
    const back = untilReset(quota?.resetsIn);
    if (after !== undefined) {
      return new ToolError(
        `Seats.aero rate limit reached while trying to ${what}. Wait ${after}s and try again.`,
        { retryable: true, data: { retryAfter: after, quota } },
      );
    }
    return new ToolError(
      `Seats.aero daily quota exhausted while trying to ${what}${suffix}. The key allows ${
        quota?.limit ?? 1000
      } partner API calls per day, shared across every app using it${
        back ? `, and resets in ${back}` : ''
      }. Retrying will not help until then.`,
      { retryable: false, data: { quota } },
    );
  }
  if (response.status === 401 || response.status === 403) {
    // A refusal to *entitle* an endpoint arrives on the same status as a bad
    // credential. Live search is gated behind a commercial agreement, and a Pro
    // key is turned away with a 401 that says so — reporting that as "check your
    // API key" would send someone to regenerate a key that works perfectly.
    if (detail && /live search/i.test(detail)) {
      return new ToolError(
        `${detail} The key itself is fine — live search is simply not part of Pro partner API access. Use search_awards, explore_availability and get_trips, which cover the same routes from Seats.aero's cache.`,
        { retryable: false },
      );
    }
    return new ToolError(
      `Seats.aero rejected the API key (HTTP ${response.status})${suffix}. Check the ${SECRET} secret — the partner API needs an active Pro subscription, and the key is generated on the API tab of https://seats.aero/settings.`,
      { retryable: false },
    );
  }
  if (response.status === 404) {
    return new ToolError(`Could not ${what} — Seats.aero returned 404 (not found)${suffix}.`, {
      retryable: false,
    });
  }
  return new ToolError(`Failed to ${what} (HTTP ${response.status})${suffix}.`, {
    retryable: response.status >= 500,
  });
}

export interface SeatsRequest {
  /** Path below `/partnerapi`, e.g. `/search?origin_airport=SFO`. */
  path: string;
  /** Human phrase for error messages, e.g. "search cached award availability". */
  what: string;
  /** Defaults to GET. */
  method?: 'GET' | 'POST';
  /** JSON request body, for POSTs. */
  body?: unknown;
}

/** A parsed response plus the quota the same response reported. */
export interface SeatsResult<T> {
  body: T;
  quota?: Quota;
}

/**
 * Call a partner API endpoint, returning the body parsed against `schema` and
 * the quota headers that came with it.
 *
 * This goes through `ctx.fetch` rather than `ctx.fetchJson` for one reason: the
 * quota is only in the **headers**, and `fetchJson` hands back a parsed body
 * alone. On an API with 1,000 calls a day shared across every app using the key,
 * "976 left, resets in 5h 57m" is worth the extra dozen lines — it is the
 * difference between budgeting and discovering the limit by hitting it. Each
 * guard `fetchJson` would have applied is reproduced here: network failure and
 * unparseable JSON are retryable, non-2xx goes through `seatsError`, and the
 * lenient schema still validates the shape.
 *
 * Validation is not decoration: the schemas in `wire.ts` are deliberately
 * lenient, so their job is to guarantee the decoders get the *shapes* they
 * expect (an array where an array belongs) without failing a call over one
 * drifted field.
 */
export async function seatsJson<S extends z.ZodTypeAny>(
  request: SeatsRequest,
  ctx: Pick<ToolContext, 'fetch'>,
  key: string,
  schema: S,
): Promise<SeatsResult<z.infer<S>>> {
  const { path, what, method = 'GET', body } = request;

  let response: Response;
  try {
    response = await ctx.fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'Partner-Authorization': authorization(key),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ToolError(`Could not reach Seats.aero to ${what}; try again shortly.`, {
      retryable: true,
    });
  }

  const text = await response.text();
  if (!response.ok) throw seatsError(what, response, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError(`Seats.aero returned a non-JSON response while trying to ${what}.`, {
      retryable: true,
    });
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new ToolError(`Seats.aero returned an unexpected shape while trying to ${what}.`, {
      retryable: true,
    });
  }
  return { body: validated.data, quota: readQuota(response) };
}
