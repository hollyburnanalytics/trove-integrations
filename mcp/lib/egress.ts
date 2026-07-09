import { type ToolContext, ToolError } from '@ontrove/mcp';

/**
 * Shared resilient-egress layer for hosted MCP servers that talk to public,
 * rate-limited APIs. A client wraps `ctx.fetch` with:
 *
 *  - an **in-isolate response cache** (TTL + LRU + per-entry and total size
 *    bounds). It is NOT durable — it only collapses duplicate requests handled
 *    by the same warm isolate — but public-API responses are typically highly
 *    cacheable, so repeats become instant and stay inside fair-access rates.
 *    Only 200 responses are cached.
 *  - a **min-interval throttle** honoring the upstream's requested rate. Under
 *    the test runtime (bun), where all egress is mocked, it is a no-op.
 *  - **retry with exponential backoff**, honoring `Retry-After`, with distinct
 *    typed errors for rate-limiting vs. outages vs. unexpected statuses.
 *
 * Create one client per server at module scope so its cache and throttle live
 * for the isolate's lifetime.
 */

export interface FetchResult {
  status: number;
  body: string;
}

export interface EgressClientOptions {
  /** Human service name used in error messages (e.g. "SEC EDGAR"). */
  service: string;
  /** Static headers sent on every request (e.g. a required User-Agent). */
  headers?: Record<string, string>;
  /** Min interval between requests in ms (no-op under the bun test runtime). */
  throttleMs: number;
  /**
   * Statuses treated as rate-limiting (retried, honoring Retry-After, and
   * surfaced as a retryable "rate-limiting" error). 429 is always included;
   * add e.g. 403 for hosts that signal rate limits with it.
   */
  rateLimitStatuses?: number[];
  /** Exponential-backoff base delay in ms (kept small so tests stay fast). */
  backoffBaseMs?: number;
  /** Test-only: apply `throttleMs` even under the bun test runtime. */
  forceThrottleInTests?: boolean;
  cache?: {
    ttlMs: number;
    maxEntries: number;
    maxEntryBytes: number;
    /** Optional bound on the sum of cached body sizes. */
    maxTotalBytes?: number;
  };
}

export interface EgressRequestOptions {
  /** `accept` header for this request (merged over the static headers). */
  accept?: string;
  /** Set false to bypass the cache for this request (default true). */
  cacheable?: boolean;
}

const inTestRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

/** A decision about a response: hand back a result, or retry after a delay. */
type ResponseDecision = { result: FetchResult } | { retryAfterMs?: number };

interface CacheEntry {
  at: number;
  value: FetchResult;
}

/** A resilient fetch client for one upstream service. */
export interface EgressClient {
  /**
   * Fetch a URL through the egress proxy with caching, throttling, and
   * retry/backoff. Returns `{ status, body }` for 2xx/400/404 (callers map
   * those to tool-specific messages); throws a {@link ToolError} for
   * rate-limits and genuine outages, with `retryable` set correctly.
   */
  fetch(ctx: ToolContext, url: string, options?: EgressRequestOptions): Promise<FetchResult>;
}

/** Build an {@link EgressClient}. Call once at module scope per server. */
export function createEgressClient(options: EgressClientOptions): EgressClient {
  const {
    service,
    headers = {},
    rateLimitStatuses = [429],
    backoffBaseMs = 50,
    cache: cacheOptions,
  } = options;
  const throttleMs = inTestRuntime && !options.forceThrottleInTests ? 0 : options.throttleMs;
  const limitStatuses = new Set([429, ...rateLimitStatuses]);

  // --- cache ---------------------------------------------------------------
  const cache = new Map<string, CacheEntry>();
  let cacheTotalBytes = 0;

  function cacheDelete(url: string): void {
    const hit = cache.get(url);
    if (!hit) return;
    cacheTotalBytes -= hit.value.body.length;
    cache.delete(url);
  }

  function cacheGet(url: string): FetchResult | undefined {
    if (!cacheOptions) return undefined;
    const hit = cache.get(url);
    if (!hit) return undefined;
    if (Date.now() - hit.at > cacheOptions.ttlMs) {
      cacheDelete(url);
      return undefined;
    }
    // Refresh recency (Map preserves insertion order → oldest is evicted first).
    cache.delete(url);
    cache.set(url, hit);
    return hit.value;
  }

  function cacheSet(url: string, value: FetchResult): void {
    if (!cacheOptions) return;
    if (value.body.length > cacheOptions.maxEntryBytes) return;
    cacheDelete(url);
    cache.set(url, { at: Date.now(), value });
    cacheTotalBytes += value.body.length;
    const maxTotal = cacheOptions.maxTotalBytes ?? Number.POSITIVE_INFINITY;
    while (cache.size > cacheOptions.maxEntries || (cacheTotalBytes > maxTotal && cache.size > 1)) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheDelete(oldest);
    }
  }

  // --- throttle --------------------------------------------------------------
  let nextAllowedAt = 0;

  /** Reserve the next request slot, waiting if we are inside the min interval. */
  async function throttle(): Promise<void> {
    if (throttleMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAllowedAt - now);
    // Advance synchronously so concurrent callers get staggered, non-overlapping slots.
    nextAllowedAt = Math.max(now, nextAllowedAt) + throttleMs;
    if (wait > 0) await sleep(wait);
  }

  /** Deterministic exponential backoff. */
  function backoffMs(attempt: number): number {
    return Math.min(2_000, backoffBaseMs * 2 ** (attempt - 1));
  }

  /**
   * Classify a response into "use this result" or "retry". Throws a typed
   * {@link ToolError} for terminal cases — a rate-limit or outage on the final
   * attempt (retryable), or an un-retryable status.
   */
  async function classifyResponse(
    res: Response,
    isLastAttempt: boolean,
  ): Promise<ResponseDecision> {
    if (limitStatuses.has(res.status)) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (!isLastAttempt) return { retryAfterMs: retryAfter };
      throw new ToolError(
        `${service} is rate-limiting requests right now. Wait a few seconds and try again.`,
        {
          retryable: true,
          data: retryAfter ? { retryAfterSeconds: Math.ceil(retryAfter / 1000) } : undefined,
        },
      );
    }
    if (res.status >= 500) {
      if (!isLastAttempt) return {};
      throw new ToolError(
        `${service} is temporarily unavailable (server error). Try again shortly.`,
        {
          retryable: true,
        },
      );
    }
    if (res.status === 400 || res.status === 404) {
      return { result: { status: res.status, body: '' } };
    }
    if (!res.ok) {
      throw new ToolError(`${service} returned an unexpected status (${res.status}).`, {
        retryable: false,
      });
    }
    return { result: { status: res.status, body: await res.text() } };
  }

  async function resilientFetch(
    ctx: ToolContext,
    url: string,
    requestOptions: EgressRequestOptions = {},
  ): Promise<FetchResult> {
    const cacheable = requestOptions.cacheable ?? true;
    if (cacheable) {
      const cached = cacheGet(url);
      if (cached) {
        ctx.log(`${service} cache hit`, { url });
        return cached;
      }
    }

    const requestHeaders = requestOptions.accept
      ? { ...headers, accept: requestOptions.accept }
      : headers;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await throttle();
      const isLast = attempt === MAX_ATTEMPTS;

      let decision: ResponseDecision;
      try {
        const res = await ctx.fetch(url, { headers: requestHeaders });
        decision = await classifyResponse(res, isLast);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (isLast) {
          throw new ToolError(`Could not reach ${service} (network error). Try again shortly.`, {
            retryable: true,
          });
        }
        await sleep(backoffMs(attempt));
        continue;
      }

      if ('result' in decision) {
        if (cacheable && decision.result.status === 200) cacheSet(url, decision.result);
        return decision.result;
      }
      await sleep(decision.retryAfterMs ?? backoffMs(attempt));
    }
    // Unreachable: the loop either returns or throws on the final attempt.
    throw new ToolError(`${service} request failed.`, { retryable: true });
  }

  return { fetch: resilientFetch };
}
