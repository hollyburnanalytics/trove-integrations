import { type ToolContext, ToolError } from '@ontrove/extend/toolkit';
import { createEgressClient } from '../lib/egress.ts';
import { metaError } from './errors.ts';

/**
 * Shared Meta Marketing API plumbing: the pinned Graph version, the egress
 * client, the authenticated GET, ad-account id normalisation, and the mapping
 * from Meta's error envelope to typed tool errors.
 *
 * **Every failure arrives as an HTTP 400 with a code.** Graph almost never uses
 * a status to say what went wrong — an expired token, a missing permission, a
 * rate limit and a typo in a field name are all `400` with an
 * `{"error":{"code":…}}` body, and the codes mean entirely different things to
 * the caller (re-authorize / ask an admin / wait / fix the request). So 400/401/
 * 403 are opted into `bodyStatuses` and {@link metaError} does the real work;
 * without it every one of them would collapse into "unexpected status (400)".
 *
 * **The token rides in a header, and the cache is salted with the caller.** The
 * response cache is module scope and shared by every tenant the isolate serves,
 * so a URL alone is NOT a safe key for an authenticated read: two users asking
 * about "their" ad accounts send byte-identical URLs. `cacheKeySalt: ctx.userId`
 * is what keeps one tenant's ad data out of another's answer.
 */

/**
 * The pinned Graph API version.
 *
 * Pinned, not omitted: a versionless Graph call is served by the OLDEST version
 * still alive on the app, which changes under us as Meta expires versions —
 * silently altering field availability. Meta supports each version for about
 * two years, and answers a call to an expired one with code 2635, which
 * {@link metaError} names.
 */
export const GRAPH_VERSION = 'v26.0';

const BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Meta publishes no fixed requests-per-second ceiling for the Marketing API —
 * capacity is a per-app/per-account points budget that varies with the account's
 * access tier — so 250 ms is politeness rather than a documented rate.
 *
 * The cache matters more here than the throttle. Insights refresh about every
 * 15 minutes upstream, so a 5-minute TTL cannot hide anything a caller could
 * otherwise have seen, and re-asking the same question (the second tool call of
 * a comparison, a re-render, a follow-up) costs no rate-limit budget at all.
 */
const meta = createEgressClient({
  service: 'Meta Marketing API',
  throttleMs: 250,
  bodyStatuses: [400, 401, 403],
  cache: {
    ttlMs: 5 * 60_000,
    maxEntries: 64,
    maxEntryBytes: 4 * 1024 * 1024,
    maxTotalBytes: 24 * 1024 * 1024,
  },
});

/** What the rate-limit headers said about this call. */
export interface RateLimitReading {
  /** Percent of the APP's insights budget consumed, per Meta. */
  appUtilPct?: number;
  /** Percent of the AD ACCOUNT's insights budget consumed, per Meta. */
  accountUtilPct?: number;
  /** The account's ads API access tier (e.g. `standard_access`). */
  tier?: string;
  /** Minutes until throttled access returns, when Meta says we are blocked. */
  regainAccessMinutes?: number;
}

/** A parsed Graph response plus what the rate-limit headers said. */
export interface GraphResponse {
  body: Record<string, unknown>;
  rateLimit?: RateLimitReading;
}

/** Read a percentage out of a throttle-header JSON blob. */
function pct(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse whatever the rate-limit headers carried.
 *
 * Best-effort by design: these headers are undocumented in shape beyond a JSON
 * blob, they differ per product, and an unparseable one must never fail a call
 * that otherwise succeeded — it is telemetry riding along with the answer.
 */
/** Parse a header that should hold JSON, or nothing if it does not. */
function headerJson(headers: Headers, name: string): Record<string, unknown> | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A malformed header is telemetry we did not get, never a failed tool call.
    return undefined;
  }
}

/**
 * The longest "you are blocked for N minutes" any business-use-case entry
 * reports. The header holds one array per ad account, one entry per product.
 */
function regainAccess(parsed: Record<string, unknown> | undefined): number | undefined {
  if (!parsed) return undefined;
  let longest: number | undefined;
  for (const entries of Object.values(parsed)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as { estimated_time_to_regain_access?: unknown }[]) {
      const minutes = pct(entry?.estimated_time_to_regain_access);
      if (minutes !== undefined && minutes > 0) longest = Math.max(longest ?? 0, minutes);
    }
  }
  return longest;
}

export function readRateLimit(headers: Headers): RateLimitReading | undefined {
  const insights = headerJson(headers, 'x-fb-ads-insights-throttle') ?? {};
  const tier = insights.ads_api_access_tier;
  const reading: RateLimitReading = {
    appUtilPct: pct(insights.app_id_util_pct),
    accountUtilPct: pct(insights.acc_id_util_pct),
    tier: typeof tier === 'string' ? tier : undefined,
    regainAccessMinutes: regainAccess(headerJson(headers, 'x-business-use-case-usage')),
  };
  return Object.values(reading).some((value) => value !== undefined) ? reading : undefined;
}

/**
 * The `appsecret_proof` Meta expects from server-side callers: an HMAC-SHA256 of
 * the access token, keyed by the app secret, hex-encoded.
 *
 * Optional here because it is optional at Meta — until an app turns on "Require
 * app secret", at which point EVERY call without it fails with code 100 and a
 * message about the proof. Supporting it costs one hash and removes a whole
 * class of "works for me, not for you" reports.
 */
async function appsecretProof(token: string, appSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A `ctx` whose `fetch` reports each response's headers on the way past.
 *
 * The shared egress client hands back a status and a body, which is everything
 * every other toolkit here needs — but Meta says how much of the ad account's
 * rate-limit budget a call just spent ONLY in `x-fb-ads-insights-throttle`, so
 * a client reading bodies alone cannot warn anyone they are at 90% until the
 * request that fails. Decorating `ctx` keeps that local to this toolkit instead
 * of widening a file every server depends on.
 *
 * It also has exactly the right behaviour on a CACHE HIT: the wrapped fetch is
 * never called, so no reading is reported — which is true, because a cached
 * answer spent no budget at all.
 */
function tapHeaders(ctx: ToolContext, tap: (headers: Headers) => void): ToolContext {
  return {
    ...ctx,
    async fetch(input, init) {
      const response = await ctx.fetch(input, init);
      tap(response.headers);
      return response;
    },
  };
}

/**
 * GET a Graph edge with the caller's token attached, returning the parsed body
 * and whatever the rate-limit headers said.
 *
 * The token goes in the `Authorization` header rather than an `access_token`
 * query parameter — both are accepted by Graph, but only one of them stays out
 * of the URL that is logged, cached and echoed back in error messages.
 */
export async function graphGet(
  ctx: ToolContext,
  path: string,
  params: URLSearchParams,
): Promise<GraphResponse> {
  const token = await ctx.requireSecret('META_ACCESS_TOKEN');
  const appSecret = await ctx.secret('META_APP_SECRET');
  if (appSecret) params.set('appsecret_proof', await appsecretProof(token, appSecret));

  const query = params.toString();
  const url = query ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;
  let rateLimit: RateLimitReading | undefined;
  const result = await meta.fetch(
    tapHeaders(ctx, (headers) => {
      rateLimit = readRateLimit(headers) ?? rateLimit;
    }),
    url,
    {
      accept: 'application/json',
      headers: { authorization: `Bearer ${token}` },
      // The URL is identical for every tenant asking about "their" accounts; the
      // salt is what stops one tenant's answer being served to another.
      cacheKeySalt: ctx.userId,
    },
  );
  if (result.status !== 200) throw metaError(result);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new ToolError('Meta returned a non-JSON response. Try again shortly.', {
      retryable: true,
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError('Meta returned malformed data. Try again shortly.', { retryable: true });
  }
  return { body: parsed as Record<string, unknown>, rateLimit };
}

/** Graph's cursor envelope, as far as the tools read it. */
export interface Paging {
  /** The cursor to pass as `after` for the next page — absent when there is none. */
  after?: string;
  /** Whether Meta says another page exists. */
  hasMore: boolean;
}

/**
 * Read Graph's paging envelope.
 *
 * `paging.next` is the ONLY reliable "there is more" signal: `cursors.after` is
 * present on the last page too, so a tool that reports "more available" from the
 * cursor alone invents a page that does not exist.
 */
export function readPaging(body: Record<string, unknown>): Paging {
  const paging = (body.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
  const after = typeof paging.cursors?.after === 'string' ? paging.cursors.after : undefined;
  const hasMore = typeof paging.next === 'string' && paging.next.length > 0;
  return { after: hasMore ? after : undefined, hasMore };
}

const ACCOUNT_ID = /^\d{1,20}$/;

/**
 * Resolve and normalise the ad account to query: the argument, else the
 * toolkit's `default_ad_account_id` setting.
 *
 * Graph wants `act_<digits>` and answers a bare number with a confusing "object
 * does not exist", so the `act_` prefix is added rather than demanded — it is
 * the one piece of Meta trivia every caller trips over, and Ads Manager shows
 * the id both ways.
 */
export function resolveAccountId(ctx: ToolContext, given: string | undefined): string {
  const stored = ctx.config?.default_ad_account_id;
  const raw = (given ?? (typeof stored === 'string' ? stored : '')).trim();
  if (!raw) {
    throw new ToolError(
      'No ad account given. Pass ad_account_id (e.g. act_1234567890), or set a default ' +
        "in the toolkit's settings. list_ad_accounts shows the ones this token can reach.",
      { retryable: false },
    );
  }
  const digits = raw.startsWith('act_') ? raw.slice(4) : raw;
  if (!ACCOUNT_ID.test(digits)) {
    throw new ToolError(
      `"${raw}" is not an ad account id. Expected act_1234567890 (or the bare digits) — ` +
        'a Business Manager id or a Page id will not work here.',
      { retryable: false },
    );
  }
  return `act_${digits}`;
}
