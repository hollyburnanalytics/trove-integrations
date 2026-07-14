import { type ToolContext, ToolError } from '@ontrove/mcp';
import { type CacheOptions, createResponseCache } from './egress-cache.ts';

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
  /**
   * The URL the response actually came from, and whether getting there took a
   * redirect.
   *
   * `fetch` follows redirects by default, so a status of 200 does NOT mean the
   * URL you asked for exists — it can equally mean the upstream bounced you to
   * somewhere else that does. That distinction is not academic: ar5iv answers a
   * request for an unrendered paper with 307 → the abstract page, and a caller
   * reading only `status` concluded "the HTML is there" and captured arXiv's
   * abstract LANDING page as if it were the paper.
   */
  url: string;
  redirected: boolean;
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
  /**
   * Deadline for a single request, in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}.
   *
   * A fetch with no deadline is the most dangerous call a tool can make. Some
   * upstreams — arXiv is one, and it is explicit about it — do not refuse
   * unwelcome traffic with a 4xx; they TARPIT it, accepting the connection and
   * then never answering. Without a deadline the tool hangs until the MCP client
   * gives up, and the caller sees "tool timed out or crashed": no status, no
   * reason, nothing to retry against. Every retry then re-hangs, so a burst of
   * saves poisons the rest of the session.
   *
   * A deadline converts that silence into a fast, typed, retryable error.
   */
  timeoutMs?: number;
  /**
   * The longest a request may WAIT for its throttle slot before being refused,
   * in ms. Defaults to {@link DEFAULT_MAX_QUEUE_MS}.
   *
   * A burst of calls queues behind the min-interval throttle. Without a ceiling
   * the last one waits its politely-earned turn well past the MCP client's
   * deadline, and the caller is told "tool timed out or crashed" — for a request
   * that never even left. A ceiling turns that into a fast, retryable error that
   * says how long to wait.
   */
  maxQueueMs?: number;
  /**
   * The budget for a whole call — every attempt, every backoff, every throttle
   * wait, added up. Defaults to {@link DEFAULT_OVERALL_TIMEOUT_MS}.
   *
   * Bounding a single request is not enough. Three attempts of ten seconds, each
   * behind a three-second throttle slot, is the better part of a minute spent
   * entirely inside limits that are individually reasonable — and the caller, who
   * gave up long ago, is told only "tool timed out or crashed". A retry loop is a
   * promise to keep trying; it is not a licence to outlive the person waiting.
   */
  overallTimeoutMs?: number;
  /** Test-only: apply `throttleMs` even under the bun test runtime. */
  forceThrottleInTests?: boolean;
  cache?: CacheOptions;
}

export interface EgressRequestOptions {
  /** `accept` header for this request (merged over the static headers). */
  accept?: string;
  /** Set false to bypass the cache for this request (default true). */
  cacheable?: boolean;
  /** HTTP method (default GET). A HEAD probe reads only the status line. */
  method?: 'GET' | 'HEAD';
  /** Override the client's {@link EgressClientOptions.timeoutMs} for this request. */
  timeoutMs?: number;
  /**
   * Override the client's {@link EgressClientOptions.overallTimeoutMs} for this
   * request. An OPTIONAL request — a probe whose failure has a fallback — should
   * give up far sooner than one the caller actually needs.
   */
  overallTimeoutMs?: number;
}

/**
 * The default single-request deadline. Long enough for a slow-but-honest upstream
 * (arXiv's API regularly takes several seconds), short enough that a tarpitted
 * connection fails well inside any MCP client's patience.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The longest a request will wait for a throttle slot before being refused. Sized
 * to stay well inside an MCP client's patience: better a clear "try again in 12s"
 * now than an opaque timeout in a minute.
 */
const DEFAULT_MAX_QUEUE_MS = 8_000;

/**
 * The default budget for a whole call, retries included. Comfortably inside an MCP
 * client's patience, so a tool always gets to say WHY it failed rather than being
 * killed mid-retry with nothing to show.
 */
const DEFAULT_OVERALL_TIMEOUT_MS = 20_000;

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

/**
 * The BUDGET for a whole call — every attempt, every backoff, every throttle wait.
 *
 * Bounding a single request is not enough, and believing otherwise cost a deploy:
 * three attempts of ten seconds, each behind a three-second throttle slot, is the
 * better part of a minute spent entirely inside limits that are individually
 * reasonable. The caller does not care that no single step misbehaved. It gave up
 * long ago, and was told "tool timed out or crashed".
 */
function startBudget(totalMs: number): {
  totalMs: number;
  /** Is there room left for a step that will take `ms`? */
  hasTimeFor: (ms: number) => boolean;
} {
  const endsAt = Date.now() + totalMs;
  return { totalMs, hasTimeFor: (ms: number) => Date.now() + ms < endsAt };
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxQueueMs = DEFAULT_MAX_QUEUE_MS,
    overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
    cache: cacheOptions,
  } = options;
  const throttleMs = inTestRuntime && !options.forceThrottleInTests ? 0 : options.throttleMs;
  const limitStatuses = new Set([429, ...rateLimitStatuses]);
  const cache = createResponseCache(cacheOptions);

  // --- throttle --------------------------------------------------------------
  let nextAllowedAt = 0;

  /**
   * Reserve the next request slot, waiting if we are inside the min interval —
   * but REFUSE a wait longer than the caller can afford.
   *
   * The throttle is correct and arXiv asks for it. Waiting silently in it is not.
   * Every save makes a few requests, each reserving a 3s slot, so a burst of six
   * saves queues up the better part of a minute of politeness — and the last one
   * sits in that queue until the MCP client gives up. The tool then reports "timed
   * out or crashed" for the one thing that is NOT a fault: an upstream we agreed
   * to be gentle with.
   *
   * So the queue has a ceiling. Past it, the request fails immediately with a
   * retryable error that says how long to wait, and the caller can decide — which
   * is worth infinitely more than a silent minute and an opaque timeout.
   */
  async function throttle(): Promise<void> {
    if (throttleMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAllowedAt - now);

    if (wait > maxQueueMs) {
      // Do NOT consume the slot we are declining to use — a refused request must
      // not push everyone behind it further back.
      throw new ToolError(
        `${service} allows about one request every ${String(Math.round(throttleMs / 1000))}s, and ${String(Math.ceil(wait / 1000))}s of requests are already queued ahead of this one. Wait a few seconds and try again.`,
        { retryable: true, data: { retryAfterSeconds: Math.ceil(wait / 1000) } },
      );
    }

    // Advance synchronously so concurrent callers get staggered, non-overlapping slots.
    nextAllowedAt = Math.max(now, nextAllowedAt) + throttleMs;
    if (wait > 0) await sleep(wait);
  }

  /** Deterministic exponential backoff. */
  function backoffMs(attempt: number): number {
    return Math.min(2_000, backoffBaseMs * 2 ** (attempt - 1));
  }

  /** Rate-limit branch: retry (honoring Retry-After) until the final attempt, then throw. */
  function handleRateLimit(res: Response, isLastAttempt: boolean): ResponseDecision {
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

  /** 5xx branch: retry until the final attempt, then throw a retryable outage error. */
  function handleServerError(isLastAttempt: boolean): ResponseDecision {
    if (!isLastAttempt) return {};
    throw new ToolError(
      `${service} is temporarily unavailable (server error). Try again shortly.`,
      {
        retryable: true,
      },
    );
  }

  /**
   * Classify a response into "use this result" or "retry". Throws a typed
   * {@link ToolError} for terminal cases — a rate-limit or outage on the final
   * attempt (retryable), or an un-retryable status.
   */
  async function classifyResponse(
    res: Response,
    isLastAttempt: boolean,
    headOnly = false,
  ): Promise<ResponseDecision> {
    if (limitStatuses.has(res.status)) return handleRateLimit(res, isLastAttempt);
    if (res.status >= 500) return handleServerError(isLastAttempt);
    if (res.status === 400 || res.status === 404) {
      return { result: { status: res.status, body: '', url: res.url, redirected: res.redirected } };
    }
    if (!res.ok) {
      throw new ToolError(`${service} returned an unexpected status (${res.status}).`, {
        retryable: false,
      });
    }
    // A HEAD response has no body to read, and awaiting one would hang.
    return {
      result: {
        status: res.status,
        body: headOnly ? '' : await res.text(),
        url: res.url,
        redirected: res.redirected,
      },
    };
  }

  /**
   * Run one fetch attempt. Returns the final result, or a delay to wait before
   * the next attempt. Throws a terminal {@link ToolError} when the request fails
   * on the last attempt (network error) or classifies as an un-retryable status.
   */
  /**
   * Turn a thrown fetch into the right terminal error.
   *
   * A TIMEOUT and a broken socket are different events and must not wear the same
   * message. "Could not reach arXiv (network error)" sends the caller looking for
   * an outage; "arXiv did not respond within 10s — it may be rate-limiting this
   * request" tells them to slow down, which is the actual remedy.
   */
  function fetchFailure(error: unknown, deadlineMs: number): never {
    if (error instanceof ToolError) throw error;
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new ToolError(
      timedOut
        ? `${service} did not respond within ${String(Math.round(deadlineMs / 1000))}s. It may be rate-limiting this request; wait a few seconds and try again.`
        : `Could not reach ${service} (network error). Try again shortly.`,
      { retryable: true },
    );
  }

  async function attemptFetch(
    ctx: ToolContext,
    url: string,
    requestHeaders: Record<string, string>,
    attempt: number,
    isLast: boolean,
    request: EgressRequestOptions,
  ): Promise<{ result: FetchResult } | { retryAfterMs: number }> {
    let decision: ResponseDecision;
    const deadline = request.timeoutMs ?? timeoutMs;
    try {
      // The DEADLINE is the point of this line. An upstream that tarpits accepts
      // the connection and never answers; without a signal this await never
      // returns, the tool hangs until the MCP client gives up, and the caller is
      // told only "tool timed out or crashed".
      const response = await ctx.fetch(url, {
        headers: requestHeaders,
        method: request.method ?? 'GET',
        signal: AbortSignal.timeout(deadline),
      });
      decision = await classifyResponse(response, isLast, request.method === 'HEAD');
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (isLast) fetchFailure(error, deadline);
      return { retryAfterMs: backoffMs(attempt) };
    }
    if ('result' in decision) return { result: decision.result };
    return { retryAfterMs: decision.retryAfterMs ?? backoffMs(attempt) };
  }

  /** Serve a cacheable request from the in-isolate cache, logging a hit. */
  function servedFromCache(
    ctx: ToolContext,
    url: string,
    cacheable: boolean,
  ): FetchResult | undefined {
    if (!cacheable) return undefined;
    const cached = cache.get(url);
    if (!cached) return undefined;
    ctx.log(`${service} cache hit`, { url });
    return cached;
  }

  /**
   * The cache key for a request. It includes the METHOD: a HEAD stores an empty
   * body, and cached under the bare URL it would be served to a later GET of the
   * same URL as a 200 with no content — leaving the caller to conclude the page
   * was blank.
   */
  function cacheKey(url: string, request: EgressRequestOptions): string {
    const method = request.method ?? 'GET';
    return method === 'GET' ? url : `${method} ${url}`;
  }

  /**
   * Attempt, back off, attempt again — until the answer arrives or the BUDGET runs
   * out, whichever comes first.
   *
   * A retry loop is a promise to keep trying. It is not a licence to outlive the
   * person waiting: every attempt, every backoff and every throttle wait is spent
   * from one budget, and when it is gone the loop says so rather than pressing on.
   */
  async function attemptUntilBudgetSpent(
    ctx: ToolContext,
    url: string,
    requestHeaders: Record<string, string>,
    request: EgressRequestOptions,
    budget: { totalMs: number; hasTimeFor: (ms: number) => boolean },
  ): Promise<FetchResult> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && budget.hasTimeFor(0); attempt++) {
      await throttle();
      const outcome = await attemptFetch(
        ctx,
        url,
        requestHeaders,
        attempt,
        attempt === MAX_ATTEMPTS,
        request,
      );
      if ('result' in outcome) return outcome.result;
      // Never sleep off a backoff we cannot afford to wake from.
      if (!budget.hasTimeFor(outcome.retryAfterMs)) break;
      await sleep(outcome.retryAfterMs);
    }

    throw new ToolError(
      `${service} did not answer within ${String(Math.round(budget.totalMs / 1000))}s, across retries. It is likely rate-limiting us right now — wait a few seconds and try again.`,
      { retryable: true },
    );
  }

  async function resilientFetch(
    ctx: ToolContext,
    url: string,
    requestOptions: EgressRequestOptions = {},
  ): Promise<FetchResult> {
    const cacheable = requestOptions.cacheable ?? true;
    const key = cacheKey(url, requestOptions);
    const cached = servedFromCache(ctx, key, cacheable);
    if (cached) return cached;

    const requestHeaders = requestOptions.accept
      ? { ...headers, accept: requestOptions.accept }
      : headers;

    const budget = startBudget(requestOptions.overallTimeoutMs ?? overallTimeoutMs);
    const result = await attemptUntilBudgetSpent(ctx, url, requestHeaders, requestOptions, budget);

    if (cacheable && result.status === 200) cache.set(key, result);
    return result;
  }

  return { fetch: resilientFetch };
}
