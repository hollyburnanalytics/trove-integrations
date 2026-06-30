/**
 * OpenAlex — a no-auth hosted MCP server over the OpenAlex scholarly graph
 * (api.openalex.org). Two read-only surfaces:
 *  - `search_works` — search 250M+ papers/books/datasets, and
 *  - `search_authors` — find researchers.
 *
 * Requests are attributed to an OpenAlex account via `ctx.requireSecret('OPENALEX_API_KEY')`
 * (passed as the `api_key` query param) — this is what makes hosting viable: the
 * shared Cloudflare egress IP otherwise exhausts OpenAlex's free per-IP budget
 * (HTTP 429). A `mailto` is also sent for the polite pool. Set the key with
 * `trove secret set openalex OPENALEX_API_KEY <key>`.
 */
import { defineMcpServer, z } from '@ontrove/mcp';
import { getJson } from '../lib/http.ts';

/** Base host for the OpenAlex API. */
const BASE_URL = 'https://api.openalex.org';

/** Contact for the OpenAlex "polite pool". Replace with your own before deploying. */
const MAILTO = 'trove-integrations@users.noreply.github.com';

/** Read `meta.count` from an OpenAlex response, defaulting to a fallback. */
function metaCount(body: Record<string, unknown>, fallback: number): number {
  const meta = (body.meta ?? {}) as { count?: unknown };
  return typeof meta.count === 'number' ? meta.count : fallback;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_works',
      title: 'OpenAlex: Search works',
      description:
        'Search scholarly works (papers, books, datasets) by free text. Returns ' +
        'title, authors, year, venue, citation count, and DOI, ranked by relevance. ' +
        'Optionally restrict by publication year.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Search text, e.g. "attention is all you need".'),
        fromYear: z.number().int().optional().describe('Only works published in/after this year.'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
      }),
      output: z.object({
        query: z.string(),
        total: z.number(),
        count: z.number(),
        works: z.array(
          z.object({
            title: z.string(),
            authors: z.array(z.string()),
            year: z.number().nullable(),
            venue: z.string().nullable(),
            citations: z.number(),
            doi: z.string().nullable(),
            id: z.string(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, fromYear, limit } = args;
        ctx.log('search_works', { query, fromYear, limit });
        const key = await ctx.requireSecret('OPENALEX_API_KEY');
        const params = new URLSearchParams({
          search: query,
          per_page: String(limit),
          mailto: MAILTO,
          api_key: key,
        });
        if (fromYear) params.set('filter', `from_publication_date:${fromYear}-01-01`);
        const body = await getJson(`${BASE_URL}/works?${params}`, ctx, { service: 'OpenAlex' });
        const results = Array.isArray(body.results) ? body.results : [];
        const works = results.map((r) => {
          const o = r as Record<string, unknown>;
          const authorships = Array.isArray(o.authorships) ? o.authorships : [];
          const authors = authorships
            .map((a) => (a as { author?: { display_name?: unknown } }).author?.display_name)
            .filter((n): n is string => typeof n === 'string')
            .slice(0, 6);
          const loc = (o.primary_location ?? {}) as { source?: { display_name?: unknown } };
          return {
            title: typeof o.display_name === 'string' ? o.display_name : 'Untitled',
            authors,
            year: typeof o.publication_year === 'number' ? o.publication_year : null,
            venue: typeof loc.source?.display_name === 'string' ? loc.source.display_name : null,
            citations: typeof o.cited_by_count === 'number' ? o.cited_by_count : 0,
            doi: typeof o.doi === 'string' ? o.doi : null,
            id: typeof o.id === 'string' ? o.id : '',
          };
        });
        if (works.length === 0) {
          return {
            text: `No works matching "${query}".`,
            structured: { query, total: 0, count: 0, works: [] },
          };
        }
        const lines = works
          .map(
            (w) =>
              `  "${w.title}"${w.year ? ` (${w.year})` : ''} — ${w.authors.slice(0, 3).join(', ') || '?'}, ${w.citations} cites`,
          )
          .join('\n');
        return {
          text: `${works.length} of ${metaCount(body, works.length)} work(s) for "${query}":\n${lines}`,
          structured: { query, total: metaCount(body, works.length), count: works.length, works },
        };
      },
    },
    {
      name: 'search_authors',
      title: 'OpenAlex: Search authors',
      description:
        'Find researchers by name. Returns each author with their works count, total ' +
        'citations, and most recent known institution.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        name: z.string().min(1).describe('Author name, e.g. "Geoffrey Hinton".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        authors: z.array(
          z.object({
            name: z.string(),
            worksCount: z.number(),
            citations: z.number(),
            institution: z.string().nullable(),
            id: z.string(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { name, limit } = args;
        ctx.log('search_authors', { name, limit });
        const key = await ctx.requireSecret('OPENALEX_API_KEY');
        const params = new URLSearchParams({
          search: name,
          per_page: String(limit),
          mailto: MAILTO,
          api_key: key,
        });
        const body = await getJson(`${BASE_URL}/authors?${params}`, ctx, { service: 'OpenAlex' });
        const results = Array.isArray(body.results) ? body.results : [];
        const authors = results.map((r) => {
          const o = r as Record<string, unknown>;
          const insts = Array.isArray(o.last_known_institutions) ? o.last_known_institutions : [];
          const inst = (insts[0] ?? {}) as { display_name?: unknown };
          return {
            name: typeof o.display_name === 'string' ? o.display_name : '',
            worksCount: typeof o.works_count === 'number' ? o.works_count : 0,
            citations: typeof o.cited_by_count === 'number' ? o.cited_by_count : 0,
            institution: typeof inst.display_name === 'string' ? inst.display_name : null,
            id: typeof o.id === 'string' ? o.id : '',
          };
        });
        if (authors.length === 0) {
          return {
            text: `No authors matching "${name}".`,
            structured: { query: name, count: 0, authors: [] },
          };
        }
        const lines = authors
          .map(
            (a) =>
              `  ${a.name}${a.institution ? ` (${a.institution})` : ''} — ${a.worksCount} works, ${a.citations} cites`,
          )
          .join('\n');
        return {
          text: `${authors.length} author(s) for "${name}":\n${lines}`,
          structured: { query: name, count: authors.length, authors },
        };
      },
    },
  ],
});
