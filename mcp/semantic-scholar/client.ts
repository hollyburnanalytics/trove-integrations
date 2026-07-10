import { ToolError, z } from '@ontrove/mcp';
import { createEgressClient } from '../lib/egress.ts';

/**
 * Shared Semantic Scholar plumbing: the resilient egress client, the Graph API
 * JSON fetch helper, and the paper wire/output shapes used by every tool in
 * `server.ts`.
 */

const BASE_URL = 'https://api.semanticscholar.org/graph/v1';

/**
 * Fields requested for every paper lookup and search result. The API omits any
 * field not listed here, so this is the complete shape we rely on downstream.
 */
export const PAPER_FIELDS =
  'paperId,externalIds,title,abstract,year,publicationDate,authors,citationCount,influentialCitationCount,openAccessPdf,venue,publicationTypes,url';

/** Raw paper shape returned by the Semantic Scholar Graph API. */
export interface S2Paper {
  paperId: string;
  externalIds: Record<string, string | undefined> | null;
  title: string | null;
  abstract: string | null;
  year: number | null;
  publicationDate: string | null;
  authors: Array<{ authorId: string | null; name: string }> | null;
  citationCount: number | null;
  influentialCitationCount: number | null;
  openAccessPdf: { url: string } | null;
  venue: string | null;
  publicationTypes: string[] | null;
  url: string | null;
}

/** Normalized paper shape this server returns in `structured`. */
export const paperSchema = z.object({
  paperId: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  authors: z.array(z.string()),
  year: z.number().nullable(),
  venue: z.string().nullable(),
  citationCount: z.number(),
  influentialCitationCount: z.number(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  openAccessPdfUrl: z.string().nullable(),
  url: z.string(),
});

/**
 * The keyless shared pool rate-limits aggressively and intermittently, so
 * requests ride the shared egress client: ~1 req/s pacing, retry with backoff
 * on 429/5xx, and an in-isolate cache for repeats. The identifying User-Agent
 * carries a real, monitored operator inbox (upstreams tarpit or throttle
 * anonymous datacenter traffic; see the arXiv and SEC connectors).
 */
const s2 = createEgressClient({
  service: 'Semantic Scholar',
  headers: {
    accept: 'application/json',
    'user-agent': 'Trove MCP (semantic-scholar@ontrove.sh)',
  },
  throttleMs: 1_100,
  backoffBaseMs: 500,
  cache: { ttlMs: 5 * 60_000, maxEntries: 128, maxEntryBytes: 256 * 1024 },
});

/**
 * Fetch JSON from the Semantic Scholar Graph API, mapping its status codes onto
 * `ToolError`s. Returns `null` on 404 so callers can render "not found".
 */
export async function s2Fetch<T>(
  ctx: Parameters<typeof s2.fetch>[0],
  path: string,
  params: URLSearchParams,
): Promise<T | null> {
  const url = `${BASE_URL}${path}?${params.toString()}`;
  ctx.log('semantic-scholar fetch', { path });

  // 429s and 5xx are retried (then surfaced as retryable errors) by the
  // egress client; only 400/404 reach here as statuses to map.
  const { status, body } = await s2.fetch(ctx, url);
  if (status === 404) {
    return null;
  }
  if (status === 400) {
    throw new ToolError('Semantic Scholar rejected the query parameters.', {
      retryable: false,
    });
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ToolError('Semantic Scholar returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
}
