import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { PAPER_FIELDS, paperSchema, type S2Paper, s2Fetch } from './client.ts';

/**
 * Semantic Scholar — a no-auth hosted MCP server over the public Semantic
 * Scholar Graph API (https://api.semanticscholar.org/graph/v1).
 *
 * The API works without credentials (at a lower, shared rate limit). To raise
 * the limit you could add an `x-api-key` header sourced from `ctx.secret`
 * (and declare it in the manifest `secrets`), but we keep this server keyless
 * for simplicity — no secrets are declared.
 *
 * Note: the Graph API returns ONLY the fields named in the `fields` query
 * param, so every request below sets it explicitly.
 */

/** Truncate an abstract for the human-readable `text` summary. */
function truncate(text: string, max = 280): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Normalize a raw API paper into this server's output shape. */
function normalizePaper(p: S2Paper): z.infer<typeof paperSchema> {
  const externalIds = p.externalIds ?? {};
  return {
    paperId: p.paperId,
    title: p.title ?? 'Untitled',
    abstract: p.abstract,
    authors: (p.authors ?? []).map((a) => a.name),
    year: p.year,
    venue: p.venue && p.venue.length > 0 ? p.venue : null,
    citationCount: p.citationCount ?? 0,
    influentialCitationCount: p.influentialCitationCount ?? 0,
    doi: externalIds.DOI ?? null,
    arxivId: externalIds.ArXiv ?? null,
    openAccessPdfUrl: p.openAccessPdf?.url ?? null,
    url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
  };
}

/** Render a one-line summary of a paper for the `text` response. */
function paperLine(p: z.infer<typeof paperSchema>): string {
  const who = p.authors.length === 0 ? 'Unknown authors' : p.authors[0];
  const etal = p.authors.length > 1 ? ' et al.' : '';
  const yr = p.year ? ` (${p.year})` : '';
  return `  ${p.title}${yr} — ${who}${etal} · ${p.citationCount} citations [${p.paperId}]`;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_papers',
      title: 'Semantic Scholar: Search papers',
      description:
        'Search academic papers on Semantic Scholar by keyword query. Returns ' +
        'title, authors, year, venue, citation counts, and identifiers (DOI/arXiv). ' +
        "Use for questions like 'recent papers on retrieval-augmented generation' " +
        "or 'find the AlphaFold paper'. Optionally filter by publication year.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Free-text search query, e.g. "graph neural networks".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe('Max papers to return (1–100). Defaults to 10.'),
        year: z
          .string()
          .optional()
          .describe(
            'Optional publication-year filter. A single year ("2023") or a ' +
              'range ("2019-2023", "2020-", "-2015").',
          ),
        minCitationCount: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Optional minimum citation count to include a paper.'),
      }),
      output: z.object({
        total: z
          .number()
          .describe('Total matches reported by the API (may exceed returned count).'),
        count: z.number().describe('Number of papers returned in this response.'),
        papers: z.array(paperSchema),
      }),
      async handler(args, ctx) {
        const { query, limit, year, minCitationCount } = args;

        const params = new URLSearchParams({
          query,
          fields: PAPER_FIELDS,
          limit: String(limit),
        });
        if (year !== undefined) {
          params.set('year', year);
        }
        if (minCitationCount !== undefined) {
          params.set('minCitationCount', String(minCitationCount));
        }

        const result = await s2Fetch<{ data: S2Paper[] | null; total: number }>(
          ctx,
          '/paper/search',
          params,
        );

        const rawPapers = result?.data ?? [];
        const total = result?.total ?? 0;
        const papers = rawPapers.map(normalizePaper);

        if (papers.length === 0) {
          return {
            text: `No papers found for "${query}".`,
            structured: { total: 0, count: 0, papers: [] },
          };
        }

        const lines = papers.map(paperLine).join('\n');
        return {
          text: `${papers.length} of ${total} match(es) for "${query}":\n${lines}`,
          structured: { total, count: papers.length, papers },
        };
      },
    },
    {
      name: 'get_paper',
      title: 'Semantic Scholar: Get paper',
      description:
        'Fetch a single paper by identifier, including its abstract. Accepts a ' +
        'Semantic Scholar paperId, or a prefixed external id such as "DOI:10.1038/nature14539", ' +
        '"arXiv:1706.03762", "PMID:12345678", or a bare URL. Returns full metadata and abstract.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z
          .string()
          .min(1)
          .describe('Paper identifier: paperId, "DOI:<doi>", "arXiv:<id>", "PMID:<id>", or a URL.'),
      }),
      output: paperSchema,
      async handler(args, ctx) {
        const { id } = args;

        const params = new URLSearchParams({ fields: PAPER_FIELDS });
        const paper = await s2Fetch<S2Paper>(ctx, `/paper/${encodeURIComponent(id)}`, params);

        if (!paper) {
          throw new ToolError(`No paper found for id "${id}".`, {
            retryable: false,
          });
        }

        const norm = normalizePaper(paper);
        const authorList = norm.authors.length > 0 ? norm.authors.join(', ') : 'Unknown authors';
        const yr = norm.year ? ` (${norm.year})` : '';
        const venue = norm.venue ? `\nVenue: ${norm.venue}` : '';
        const abstract = norm.abstract
          ? `\n\n${truncate(norm.abstract, 600)}`
          : '\n\n(No abstract available.)';

        return {
          text:
            `${norm.title}${yr}\n${authorList}` +
            `${venue}\nCitations: ${norm.citationCount} ` +
            `(${norm.influentialCitationCount} influential)\n${norm.url}` +
            abstract,
          structured: norm,
        };
      },
    },
    {
      name: 'get_paper_citations',
      title: 'Semantic Scholar: Citations',
      description:
        'List papers that CITE a given paper (its citing literature). Useful for ' +
        "finding follow-on work, e.g. 'who built on the Transformer paper?'. " +
        'Accepts the same identifier forms as get_paper.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('Paper identifier (paperId, "DOI:…", "arXiv:…", etc.).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe('Max citing papers to return (1–100). Defaults to 10.'),
      }),
      output: z.object({
        count: z.number(),
        papers: z.array(paperSchema),
      }),
      async handler(args, ctx) {
        const { id, limit } = args;

        // The citations endpoint nests each cited-by paper under `citingPaper`.
        const params = new URLSearchParams({
          fields: PAPER_FIELDS,
          limit: String(limit),
        });
        const result = await s2Fetch<{
          data: Array<{ citingPaper: S2Paper }> | null;
        }>(ctx, `/paper/${encodeURIComponent(id)}/citations`, params);

        if (!result) {
          throw new ToolError(`No paper found for id "${id}".`, {
            retryable: false,
          });
        }

        const papers = (result.data ?? []).map((d) => normalizePaper(d.citingPaper));

        if (papers.length === 0) {
          return {
            text: `No citations found for "${id}".`,
            structured: { count: 0, papers: [] },
          };
        }

        const lines = papers.map(paperLine).join('\n');
        return {
          text: `${papers.length} paper(s) citing "${id}":\n${lines}`,
          structured: { count: papers.length, papers },
        };
      },
    },
    {
      name: 'get_paper_references',
      title: 'Semantic Scholar: References',
      description:
        'List the papers a given paper REFERENCES (its bibliography). Useful for ' +
        "tracing intellectual lineage, e.g. 'what did this paper build on?'. " +
        'Accepts the same identifier forms as get_paper.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('Paper identifier (paperId, "DOI:…", "arXiv:…", etc.).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe('Max referenced papers to return (1–100). Defaults to 10.'),
      }),
      output: z.object({
        count: z.number(),
        papers: z.array(paperSchema),
      }),
      async handler(args, ctx) {
        const { id, limit } = args;

        // The references endpoint nests each cited paper under `citedPaper`.
        const params = new URLSearchParams({
          fields: PAPER_FIELDS,
          limit: String(limit),
        });
        const result = await s2Fetch<{
          data: Array<{ citedPaper: S2Paper }> | null;
        }>(ctx, `/paper/${encodeURIComponent(id)}/references`, params);

        if (!result) {
          throw new ToolError(`No paper found for id "${id}".`, {
            retryable: false,
          });
        }

        const papers = (result.data ?? []).map((d) => normalizePaper(d.citedPaper));

        if (papers.length === 0) {
          return {
            text: `No references found for "${id}".`,
            structured: { count: 0, papers: [] },
          };
        }

        const lines = papers.map(paperLine).join('\n');
        return {
          text: `${papers.length} reference(s) for "${id}":\n${lines}`,
          structured: { count: papers.length, papers },
        };
      },
    },
  ],
});
