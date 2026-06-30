import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * arXiv — a no-auth hosted MCP server over the public arXiv API.
 *
 * The arXiv API returns Atom XML (not JSON), and the runtime has no
 * DOMParser, so entries are parsed with string/regex extraction below.
 */

const ARXIV_API = 'https://export.arxiv.org/api/query';

/** A single parsed arXiv paper. */
interface ArxivPaper {
  /** Bare arXiv identifier, e.g. "2510.25417". */
  id: string;
  /** Paper title (whitespace-normalized). */
  title: string;
  /** Author display names, in listed order. */
  authors: string[];
  /** Full abstract / summary (whitespace-normalized). */
  summary: string;
  /** Original submission date (ISO 8601). */
  published: string;
  /** Last-updated date (ISO 8601). */
  updated: string;
  /** arXiv subject categories, e.g. ["cs.LG", "stat.ML"]. */
  categories: string[];
  /** Direct link to the PDF. */
  pdfUrl: string;
  /** Link to the arXiv abstract page. */
  arxivUrl: string;
}

/** Collapse runs of whitespace to single spaces and trim. */
function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Decode the handful of XML entities arXiv emits in text fields. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract the inner text of the first `<tag>...</tag>` in `xml`, or `''`. */
function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] ? decodeXmlEntities(squish(match[1])) : '';
}

/** Reduce a full arXiv id URL to its bare identifier ("...abs/2510.25417v1" → "2510.25417"). */
function bareId(idUrl: string): string {
  const match = /abs\/(.+?)(?:v\d+)?$/.exec(idUrl);
  return match?.[1] ?? idUrl;
}

/** Parse a single `<entry>...</entry>` block into an {@link ArxivPaper}. */
function parseEntry(entry: string): ArxivPaper {
  const id = bareId(tagText(entry, 'id'));

  // Authors: every <author><name>...</name></author>.
  const authors: string[] = [];
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/g;
  for (let m = authorRe.exec(entry); m !== null; m = authorRe.exec(entry)) {
    const name = tagText(m[1] ?? '', 'name');
    if (name) authors.push(name);
  }

  // Categories: every <category term="..."/>.
  const categories: string[] = [];
  const catRe = /<category\b[^>]*\bterm="([^"]*)"/g;
  for (let m = catRe.exec(entry); m !== null; m = catRe.exec(entry)) {
    if (m[1]) categories.push(decodeXmlEntities(m[1]));
  }

  // PDF link: <link title="pdf" href="..."/>. Fall back to the canonical path.
  const pdfRe =
    /<link\b[^>]*\btitle="pdf"[^>]*\bhref="([^"]*)"|<link\b[^>]*\bhref="([^"]*)"[^>]*\btitle="pdf"/;
  const pdfMatch = pdfRe.exec(entry);
  const pdfUrl = pdfMatch?.[1] ?? pdfMatch?.[2] ?? `https://arxiv.org/pdf/${id}`;

  return {
    id,
    title: tagText(entry, 'title'),
    authors,
    summary: tagText(entry, 'summary'),
    published: tagText(entry, 'published'),
    updated: tagText(entry, 'updated'),
    categories,
    pdfUrl,
    arxivUrl: `https://arxiv.org/abs/${id}`,
  };
}

/** Split an Atom feed into its `<entry>` blocks and parse each one. */
function parseFeed(xml: string): ArxivPaper[] {
  const entries: ArxivPaper[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  for (let m = entryRe.exec(xml); m !== null; m = entryRe.exec(xml)) {
    const block = m[1] ?? '';
    // arXiv returns an error stub entry (no real id/title) for bad queries.
    const paper = parseEntry(block);
    if (paper.id && paper.title) entries.push(paper);
  }
  return entries;
}

/** Truncate long abstracts for the human-readable text summary. */
function truncate(value: string, max = 280): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

const paperShape = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  summary: z.string(),
  published: z.string(),
  updated: z.string(),
  categories: z.array(z.string()),
  pdfUrl: z.string(),
  arxivUrl: z.string(),
});

/** Map our friendly sort labels to arXiv's `sortBy` values. */
const SORT_BY = {
  relevance: 'relevance',
  lastUpdated: 'lastUpdatedDate',
  submitted: 'submittedDate',
} as const;

export default defineMcpServer({
  tools: [
    {
      name: 'search_papers',
      title: 'arXiv: Search papers',
      description:
        'Search arXiv.org for scientific papers by free-text query, optionally ' +
        'restricted to a subject category (e.g. "cs.LG", "astro-ph"). Returns ' +
        'titles, authors, abstracts, dates, categories and links. Use for ' +
        "questions like 'recent papers on diffusion models in cs.LG'.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .min(1)
          .describe('Free-text search terms, matched across title, abstract and authors.'),
        category: z
          .string()
          .optional()
          .describe('Optional arXiv subject category to restrict to, e.g. "cs.LG" or "math.NT".'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum papers to return (1–50). Defaults to 10.'),
        sortBy: z
          .enum(['relevance', 'lastUpdated', 'submitted'])
          .default('relevance')
          .describe('Sort order: relevance, lastUpdated (last updated date), or submitted.'),
      }),
      output: z.object({
        count: z.number(),
        papers: z.array(paperShape),
      }),
      async handler(args, ctx) {
        const { query, category, maxResults, sortBy } = args;

        // arXiv search_query field prefixes: all: (everything), cat: (category).
        // Each value is URL-encoded, but the literal "+AND+" boolean joiner is
        // kept verbatim (arXiv requires it unescaped).
        const parts = [`all:${encodeURIComponent(query)}`];
        if (category) parts.push(`cat:${encodeURIComponent(category)}`);
        const searchQuery = parts.join('+AND+');

        const params = new URLSearchParams({
          start: '0',
          max_results: String(maxResults),
          sortBy: SORT_BY[sortBy as keyof typeof SORT_BY],
          sortOrder: 'descending',
        });
        // search_query is assembled by hand (the +AND+ joiner must stay literal),
        // so it is appended rather than added via URLSearchParams.
        const url = `${ARXIV_API}?search_query=${searchQuery}&${params.toString()}`;

        ctx.log('search_papers querying arXiv', { query, category, maxResults, sortBy });

        const res = await ctx.fetch(url, { headers: { accept: 'application/atom+xml' } });
        if (res.status === 400) {
          throw new ToolError('arXiv rejected the search query.', { retryable: false });
        }
        if (!res.ok) {
          throw new ToolError('arXiv is temporarily unavailable.', { retryable: true });
        }

        const papers = parseFeed(await res.text());

        if (papers.length === 0) {
          return {
            text: `No arXiv papers found for "${query}"${category ? ` in ${category}` : ''}.`,
            structured: { count: 0, papers: [] },
          };
        }

        const lines = papers
          .slice(0, 10)
          .map((p) => {
            const who = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
            return (
              `  ${p.id} — ${p.title}\n` +
              `    ${who} · ${p.published.slice(0, 10)} · ${p.categories.join(', ')}\n` +
              `    ${truncate(p.summary)}`
            );
          })
          .join('\n');

        return {
          text: `${papers.length} arXiv paper(s) for "${query}":\n${lines}`,
          structured: { count: papers.length, papers },
        };
      },
    },
    {
      name: 'get_paper',
      title: 'arXiv: Get paper',
      description:
        'Fetch a single arXiv paper by its identifier (e.g. "2510.25417" or ' +
        '"2510.25417v1"). Returns the title, authors, full abstract, dates, ' +
        'categories and links.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z
          .string()
          .min(1)
          .describe('arXiv paper id, e.g. "2510.25417" (an optional version suffix is allowed).'),
      }),
      output: paperShape,
      async handler(args, ctx) {
        const { id } = args;

        const url = `${ARXIV_API}?id_list=${encodeURIComponent(id)}`;
        ctx.log('get_paper querying arXiv', { id });

        const res = await ctx.fetch(url, { headers: { accept: 'application/atom+xml' } });
        if (res.status === 400) {
          throw new ToolError(`arXiv rejected the id "${id}".`, { retryable: false });
        }
        if (!res.ok) {
          throw new ToolError('arXiv is temporarily unavailable.', { retryable: true });
        }

        const papers = parseFeed(await res.text());
        const paper = papers[0];
        if (!paper) {
          throw new ToolError(`No arXiv paper found with id "${id}".`, { retryable: false });
        }

        const who = paper.authors.join(', ');
        return {
          text:
            `${paper.id} — ${paper.title}\n` +
            `${who}\n` +
            `Published ${paper.published.slice(0, 10)} · Updated ${paper.updated.slice(0, 10)} · ` +
            `${paper.categories.join(', ')}\n` +
            `PDF: ${paper.pdfUrl}\n\n` +
            paper.summary,
          structured: paper,
        };
      },
    },
  ],
});
