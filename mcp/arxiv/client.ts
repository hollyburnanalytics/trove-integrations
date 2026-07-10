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
  cache: { ttlMs: 5 * 60_000, maxEntries: 256, maxEntryBytes: 256 * 1024 },
});

/** Fetch an arXiv URL resiliently; see {@link createEgressClient}. */
export const arxivFetch = (
  ctx: ToolContext,
  url: string,
  opts: { accept: string; cacheable?: boolean },
): Promise<FetchResult> => arxiv.fetch(ctx, url, opts);
