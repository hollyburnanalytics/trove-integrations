import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { ARXIV_API, arxivFetch } from '../client.ts';
import { authorLine, paperShape, truncate } from '../papers.ts';
import { parseFeed, totalResults } from '../parse.ts';
import { buildSearchQuery, SORT_BY } from '../search-query.ts';

/** `search_papers` — search arXiv.org for papers (free-text or field-scoped). */
export const searchPapers: ToolDefinition = {
  name: 'search_papers',
  title: 'arXiv: Search papers',
  description:
    'Search arXiv.org for scientific papers. Free-text (`query`) or field-scoped ' +
    '(`title`, `abstract`, `author`, `category`), narrowed by submission date ' +
    '(`from_date`/`to_date`, e.g. "2026" or "2026-01-15") and paged with `start`. ' +
    'For boolean precision (OR / ANDNOT) pass a raw arXiv expression in `advanced` ' +
    '(e.g. `ti:transformer ANDNOT abs:vision`). Returns titles, authors, abstracts, ' +
    'dates, categories and links.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free-text terms matched across title, abstract and authors.'),
    title: z.string().optional().describe('Terms that must appear in the title (ti:).'),
    abstract: z.string().optional().describe('Terms that must appear in the abstract (abs:).'),
    author: z.string().optional().describe('Author name to match (au:).'),
    category: z
      .string()
      .optional()
      .describe('arXiv subject category to restrict to, e.g. "cs.LG" or "math.NT" (cat:).'),
    from_date: z
      .string()
      .optional()
      .describe('Only papers submitted on/after this date. "2026", "2026-03", or "2026-03-01".'),
    to_date: z
      .string()
      .optional()
      .describe('Only papers submitted on/before this date. Same formats as from_date.'),
    advanced: z
      .string()
      .optional()
      .describe(
        "Raw arXiv search_query for full boolean control; overrides the fields above. E.g. 'au:hinton AND cat:cs.LG'.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum papers to return per page (1–100). Defaults to 10.'),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Result offset for pagination. Use the returned nextStart to page deeper.'),
    sortBy: z
      .enum(['relevance', 'lastUpdated', 'submitted'])
      .default('relevance')
      .describe('Sort order: relevance, lastUpdated, or submitted (newest first).'),
  }),
  output: z.object({
    count: z.number(),
    total: z.number(),
    start: z.number(),
    nextStart: z.number().nullable(),
    hasMore: z.boolean(),
    papers: z.array(paperShape),
  }),
  async handler(args, ctx) {
    const { maxResults, start, sortBy } = args;
    const searchQuery = buildSearchQuery({
      query: args.query,
      title: args.title,
      abstract: args.abstract,
      author: args.author,
      category: args.category,
      fromDate: args.from_date,
      toDate: args.to_date,
      advanced: args.advanced,
    });

    const params = new URLSearchParams({
      start: String(start),
      max_results: String(maxResults),
      sortBy: SORT_BY[sortBy as keyof typeof SORT_BY],
      sortOrder: 'descending',
    });
    // search_query is appended raw: its `+AND+` joiners and `[lo+TO+hi]`
    // ranges must stay literal, which URLSearchParams would re-encode.
    const url = `${ARXIV_API}?search_query=${searchQuery}&${params.toString()}`;

    ctx.log('search_papers querying arXiv', { searchQuery, start, maxResults, sortBy });

    const { status, body } = await arxivFetch(ctx, url, { accept: 'application/atom+xml' });
    if (status === 400) {
      // Say what was actually sent. "arXiv rejected the search query" told the
      // caller nothing about WHICH query, and the answer was usually that we had
      // mangled theirs — a `ti:...` typed into `query` came out as `all:ti%3A...`.
      throw new ToolError(
        `arXiv rejected the search query: ${searchQuery}. Field prefixes (ti:, abs:, au:, cat:) and ` +
          'boolean operators (AND/OR/ANDNOT) are understood in `query`; a quoted phrase needs its ' +
          'quotes ("Apache Kafka").',
        { retryable: false },
      );
    }

    const papers = parseFeed(body);
    const total = totalResults(body);
    const nextOffset = start + papers.length;
    const hasMore = papers.length === maxResults && (total === 0 || nextOffset < total);

    if (papers.length === 0) {
      return {
        text: 'No arXiv papers found for that query.',
        structured: { count: 0, total, start, nextStart: null, hasMore: false, papers: [] },
      };
    }

    const lines = papers
      .slice(0, 10)
      .map(
        (p) =>
          `  ${p.id} — ${p.title}\n` +
          `    ${authorLine(p.authors)} · ${p.published.slice(0, 10)} · ${p.categories.join(', ')}\n` +
          `    ${truncate(p.summary)}`,
      )
      .join('\n');
    const more = hasMore ? `\n(more results — call again with start=${nextOffset})` : '';

    return {
      text: `${total ? `${total} match(es); showing ${papers.length}` : `${papers.length} paper(s)`}:\n${lines}${more}`,
      structured: {
        count: papers.length,
        total,
        start,
        nextStart: hasMore ? nextOffset : null,
        hasMore,
        papers,
      },
    };
  },
};
