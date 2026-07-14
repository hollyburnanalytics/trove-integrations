import type { ToolContext } from '@ontrove/mcp';
import { createEgressClient, type FetchResult } from '../lib/egress.ts';

/**
 * Shared arXiv egress plumbing for the arxiv server modules: the resilient
 * fetch client (in-isolate cache, throttle, retry/backoff) plus the search/
 * metadata API endpoint and the HTML-view URL builders used across the tools.
 */

export const ARXIV_API = 'https://export.arxiv.org/api/query';
export const arxivHtmlUrl = (id: string): string => `https://arxiv.org/html/${id}`;
export const ar5ivHtmlUrl = (id: string): string => `https://ar5iv.labs.arxiv.org/html/${id}`;

// ---------------------------------------------------------------------------
// Egress: shared in-isolate cache + throttle + retry/backoff (mcp/lib/egress)
// ---------------------------------------------------------------------------

/**
 * arXiv API etiquette asks for an identifying User-Agent with a contact
 * address; unidentified datacenter traffic gets tarpitted (requests hang with
 * no response rather than a clean 4xx). Like the SEC connector's UA, the
 * contact must stay a real, monitored operator inbox.
 */
const CONTACT_EMAIL = 'arxiv@ontrove.sh';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

/**
 * arXiv metadata is highly cacheable, so repeats are served from the
 * in-isolate cache. arXiv asks for ~3s between requests (throttled).
 */
const arxiv = createEgressClient({
  service: 'arXiv',
  headers: { 'user-agent': USER_AGENT },
  throttleMs: 3_000,
  backoffBaseMs: 50,
  // arXiv signals "you are going too fast" with **503**, not 429 — it is the
  // documented response on the export API. Left out of this list, a 503 was
  // treated as a generic outage: retried on a plain backoff, ignoring the
  // `Retry-After` arXiv sends telling us exactly how long to wait.
  rateLimitStatuses: [429, 503],
  // Every request gets a deadline. arXiv TARPITS traffic it doesn't like — it
  // accepts the connection and never answers (see the User-Agent note above) —
  // and an un-deadlined fetch turns that into a hang, then an opaque "tool timed
  // out or crashed", then a session where every retry hangs the same way.
  timeoutMs: 8_000,
  // And a budget for the WHOLE call, retries and throttle waits included. Three
  // attempts of ten seconds behind a three-second throttle is the better part of a
  // minute — every step inside its own reasonable limit, and the caller long gone.
  overallTimeoutMs: 12_000,
  cache: { ttlMs: 5 * 60_000, maxEntries: 256, maxEntryBytes: 256 * 1024 },
});

/** Fetch an arXiv URL resiliently; see {@link createEgressClient}. */
export const arxivFetch = (
  ctx: ToolContext,
  url: string,
  opts: {
    accept: string;
    cacheable?: boolean;
    method?: 'GET' | 'HEAD';
    timeoutMs?: number;
    overallTimeoutMs?: number;
  },
): Promise<FetchResult> => arxiv.fetch(ctx, url, opts);
