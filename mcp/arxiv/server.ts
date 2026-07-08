import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';

/**
 * arXiv — a no-auth hosted MCP server over the public arXiv API.
 *
 * The search/metadata API returns Atom XML (not JSON) and the runtime has no
 * DOMParser, so both the Atom feed and the LaTeXML full-text HTML are parsed
 * with string/regex extraction below.
 *
 * Egress is resilient: an in-isolate cache collapses repeat queries, requests
 * are throttled to arXiv's requested rate, and failures retry with backoff and
 * surface a distinct, actionable error for rate-limits vs. genuine outages.
 */

const ARXIV_API = 'https://export.arxiv.org/api/query';
const arxivHtmlUrl = (id: string): string => `https://arxiv.org/html/${id}`;
const ar5ivHtmlUrl = (id: string): string => `https://ar5iv.labs.arxiv.org/html/${id}`;

// ---------------------------------------------------------------------------
// Shared egress: in-isolate cache + throttle + retry/backoff (feedback pt 2)
// ---------------------------------------------------------------------------

/**
 * A best-effort cache that lives for the life of a warm isolate (the same
 * module-scoped pattern the SDK uses for OAuth tokens). It is NOT a global,
 * durable cache — it only collapses duplicate requests handled by the same
 * instance — but arXiv metadata is highly cacheable, so it makes repeats
 * instant and sidesteps most rate-limit responses. Bounded by entry count,
 * per-entry size, and TTL.
 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 256;
const CACHE_MAX_BYTES = 256 * 1024;
interface CacheEntry {
  at: number;
  value: FetchResult;
}
const responseCache = new Map<string, CacheEntry>();

function cacheGet(url: string): FetchResult | undefined {
  const hit = responseCache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    responseCache.delete(url);
    return undefined;
  }
  // Refresh recency (Map preserves insertion order → oldest is evicted first).
  responseCache.delete(url);
  responseCache.set(url, hit);
  return hit.value;
}

function cacheSet(url: string, value: FetchResult): void {
  if (value.body.length > CACHE_MAX_BYTES) return;
  responseCache.set(url, { at: Date.now(), value });
  if (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
}

/**
 * arXiv asks for ~3s between requests. A per-isolate min-interval throttle
 * honors that in the hosted runtime; under the test runtime (bun), where all
 * egress is mocked and there is no real host to be polite to, it is a no-op.
 */
const inTestRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const THROTTLE_MS = inTestRuntime ? 0 : 3_000;
let nextAllowedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reserve the next request slot, waiting if we are inside the min interval. */
async function throttle(): Promise<void> {
  if (THROTTLE_MS <= 0) return;
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  // Advance synchronously so concurrent callers get staggered, non-overlapping slots.
  nextAllowedAt = Math.max(now, nextAllowedAt) + THROTTLE_MS;
  if (wait > 0) await sleep(wait);
}

/** Deterministic exponential backoff (kept small so tests stay fast). */
function backoffMs(attempt: number): number {
  return Math.min(2_000, 50 * 2 ** (attempt - 1));
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

interface FetchResult {
  status: number;
  body: string;
}

/** A decision about an arXiv response: hand back a result, or retry after a delay. */
type ResponseDecision = { result: FetchResult } | { retryAfterMs?: number };

/**
 * Classify an arXiv response into "use this result" or "retry". Throws a typed
 * {@link ToolError} for terminal cases — a rate-limit or outage on the final
 * attempt (retryable), or an un-retryable status.
 */
async function classifyResponse(res: Response, isLastAttempt: boolean): Promise<ResponseDecision> {
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    if (!isLastAttempt) return { retryAfterMs: retryAfter };
    throw new ToolError(
      'arXiv is rate-limiting requests right now (HTTP 429). Wait a few seconds and try again.',
      {
        retryable: true,
        data: retryAfter ? { retryAfterSeconds: Math.ceil(retryAfter / 1000) } : undefined,
      },
    );
  }
  if (res.status >= 500) {
    if (!isLastAttempt) return {};
    throw new ToolError('arXiv is temporarily unavailable (server error). Try again shortly.', {
      retryable: true,
    });
  }
  if (res.status === 400 || res.status === 404) return { result: { status: res.status, body: '' } };
  if (!res.ok) {
    throw new ToolError(`arXiv returned an unexpected status (${res.status}).`, {
      retryable: false,
    });
  }
  return { result: { status: res.status, body: await res.text() } };
}

/**
 * Fetch an arXiv URL through the egress proxy with caching, throttling, and
 * retry/backoff. Returns `{ status, body }` for 2xx/400/404 (callers map those
 * to tool-specific messages); throws a {@link ToolError} for rate-limits and
 * genuine outages, with `retryable` set correctly.
 */
async function arxivFetch(
  ctx: ToolContext,
  url: string,
  opts: { accept: string; cacheable?: boolean },
): Promise<FetchResult> {
  const cacheable = opts.cacheable ?? true;
  if (cacheable) {
    const cached = cacheGet(url);
    if (cached) {
      ctx.log('arxiv cache hit', { url });
      return cached;
    }
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const isLast = attempt === MAX_ATTEMPTS;

    let decision: ResponseDecision;
    try {
      const res = await ctx.fetch(url, { headers: { accept: opts.accept } });
      decision = await classifyResponse(res, isLast);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (isLast) {
        throw new ToolError('Could not reach arXiv (network error). Try again shortly.', {
          retryable: true,
        });
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if ('result' in decision) {
      if (cacheable) cacheSet(url, decision.result);
      return decision.result;
    }
    await sleep(decision.retryAfterMs ?? backoffMs(attempt));
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new ToolError('arXiv request failed.', { retryable: true });
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace to single spaces and trim. */
function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Decode the XML/HTML entities arXiv and LaTeXML emit (named + numeric). */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/** Safely turn a code point into a string, dropping invalid ones. */
function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Strip HTML/XML tags to plain text (dropping script/style), then decode + squish. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return squish(decodeEntities(stripped));
}

// ---------------------------------------------------------------------------
// Atom feed parsing (metadata)
// ---------------------------------------------------------------------------

interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
  arxivUrl: string;
}

/** Extract the inner text of the first `<tag>...</tag>` in `xml`, or `''`. */
function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] ? decodeEntities(squish(match[1])) : '';
}

/** Reduce a full arXiv id URL to its bare identifier ("...abs/2510.25417v1" → "2510.25417"). */
function bareId(idUrl: string): string {
  const match = /abs\/(.+?)(?:v\d+)?$/.exec(idUrl);
  return match?.[1] ?? idUrl;
}

/** Parse a single `<entry>...</entry>` block into an {@link ArxivPaper}. */
function parseEntry(entry: string): ArxivPaper {
  const id = bareId(tagText(entry, 'id'));

  const authors: string[] = [];
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/g;
  for (let m = authorRe.exec(entry); m !== null; m = authorRe.exec(entry)) {
    const name = tagText(m[1] ?? '', 'name');
    if (name) authors.push(name);
  }

  const categories: string[] = [];
  const catRe = /<category\b[^>]*\bterm="([^"]*)"/g;
  for (let m = catRe.exec(entry); m !== null; m = catRe.exec(entry)) {
    if (m[1]) categories.push(decodeEntities(m[1]));
  }

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
    const paper = parseEntry(m[1] ?? '');
    // arXiv returns an error stub entry (no real id/title) for bad queries.
    if (paper.id && paper.title) entries.push(paper);
  }
  return entries;
}

/** Total match count arXiv reports for the query (for pagination), or 0. */
function totalResults(xml: string): number {
  const match = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(xml);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

// ---------------------------------------------------------------------------
// LaTeXML HTML parsing (full text + references — feedback pts 1, 7)
// ---------------------------------------------------------------------------

type SectionKind =
  | 'introduction'
  | 'background'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'other';

interface PaperSection {
  title: string;
  kind: SectionKind;
  text: string;
}

interface PaperContent {
  abstract: string;
  sections: PaperSection[];
  references: string[];
  citedArxivIds: string[];
}

/** Classify a section by its heading so an agent can ask for just "results". */
function classifySection(title: string): SectionKind {
  const t = title.toLowerCase();
  if (/introduction/.test(t)) return 'introduction';
  if (/related work|background|preliminar/.test(t)) return 'background';
  if (/method|approach|architecture|model|experimental setup|dataset/.test(t)) return 'methods';
  if (/result|evaluation|experiment|finding|ablation/.test(t)) return 'results';
  if (/discussion|analysis|limitation/.test(t)) return 'discussion';
  if (/conclusion|future work|summary/.test(t)) return 'conclusion';
  return 'other';
}

/** Pull arXiv ids out of reference text, for citation-graph traversal. */
function extractArxivIds(references: string[]): string[] {
  const ids = new Set<string>();
  const re = /(?:arxiv:\s*|abs\/|\/)?\b(\d{4}\.\d{4,5})(?:v\d+)?\b/gi;
  for (const ref of references) {
    for (let m = re.exec(ref); m !== null; m = re.exec(ref)) {
      if (m[1]) ids.add(m[1]);
    }
  }
  return [...ids];
}

/**
 * Parse LaTeXML full-text HTML (from arXiv's HTML view or ar5iv) into an
 * abstract, titled sections, and the reference list. Best-effort: papers whose
 * HTML lacks section markup degrade to a single "Full text" section.
 */
function parseHtmlContent(html: string): PaperContent {
  const absMatch = /<div\b[^>]*\bclass="[^"]*\bltx_abstract\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
    html,
  );
  const abstract = absMatch
    ? htmlToText((absMatch[1] ?? '').replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i, ''))
    : '';

  // The bibliography ends the body; references live after it.
  const biblioMatch =
    /<section\b[^>]*\bclass="[^"]*\bltx_bibliography\b[^"]*"/i.exec(html) ??
    /<(?:section|div|ul)\b[^>]*\bclass="[^"]*\bltx_biblist\b[^"]*"/i.exec(html);
  const biblioAt = biblioMatch ? biblioMatch.index : html.length;
  const body = html.slice(0, biblioAt);

  // Top-level section headings.
  const headingRe = /<h2\b[^>]*\bclass="[^"]*\bltx_title_section\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi;
  const heads: { title: string; start: number; end: number }[] = [];
  for (let m = headingRe.exec(body); m !== null; m = headingRe.exec(body)) {
    const title = htmlToText(m[1] ?? '').replace(/^\d+(?:\.\d+)*\s*/, '');
    heads.push({ title, start: m.index, end: headingRe.lastIndex });
  }

  const sections: PaperSection[] = [];
  if (heads.length > 0) {
    for (let i = 0; i < heads.length; i++) {
      const from = heads[i]?.end ?? 0;
      const to = heads[i + 1]?.start ?? body.length;
      const text = htmlToText(body.slice(from, to));
      const title = heads[i]?.title ?? 'Section';
      if (text) sections.push({ title, kind: classifySection(title), text });
    }
  } else {
    const text = htmlToText(body);
    if (text) sections.push({ title: 'Full text', kind: 'other', text });
  }

  const references: string[] = [];
  if (biblioMatch) {
    const biblioHtml = html.slice(biblioAt);
    const bibRe = /<li\b[^>]*\bclass="[^"]*\bltx_bibitem\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    for (let m = bibRe.exec(biblioHtml); m !== null; m = bibRe.exec(biblioHtml)) {
      const ref = htmlToText(m[1] ?? '');
      if (ref) references.push(ref);
    }
  }

  return { abstract, sections, references, citedArxivIds: extractArxivIds(references) };
}

/** Fetch a paper's LaTeXML HTML, trying arXiv's native view then ar5iv. */
async function fetchPaperHtml(ctx: ToolContext, id: string): Promise<string | null> {
  for (const url of [arxivHtmlUrl(id), ar5ivHtmlUrl(id)]) {
    const { status, body } = await arxivFetch(ctx, url, { accept: 'text/html' });
    // A real LaTeXML page contains `ltx_` classes; a stub/redirect won't.
    if (status === 200 && body.includes('ltx_')) return body;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search query building (feedback pts 3, 4)
// ---------------------------------------------------------------------------

const SORT_BY = {
  relevance: 'relevance',
  lastUpdated: 'lastUpdatedDate',
  submitted: 'submittedDate',
} as const;

/** Normalize a date input ("2026", "2026-03", "20260315") to arXiv's YYYYMMDD. */
function toArxivDate(input: string, end: boolean): string {
  const digits = input.replace(/[^0-9]/g, '');
  if (digits.length === 4) return `${digits}${end ? '1231' : '0101'}`;
  if (digits.length === 6) return `${digits}${end ? '31' : '01'}`;
  if (digits.length === 8) return digits;
  throw new ToolError(`Could not parse the date "${input}". Use YYYY, YYYY-MM, or YYYY-MM-DD.`, {
    retryable: false,
  });
}

interface SearchInput {
  query?: string;
  title?: string;
  abstract?: string;
  author?: string;
  category?: string;
  fromDate?: string;
  toDate?: string;
  advanced?: string;
}

/** Compose an arXiv `search_query` from the structured params (or a raw expression). */
function buildSearchQuery(input: SearchInput): string {
  // Power users can pass arXiv's native grammar (ti:, abs:, AND/OR/ANDNOT).
  // Spaces become `+` so operators like " AND " read as the literal `+AND+`.
  if (input.advanced?.trim()) return input.advanced.trim().replace(/\s+/g, '+');

  const enc = (v: string): string => encodeURIComponent(v);
  const parts: string[] = [];
  if (input.query) parts.push(`all:${enc(input.query)}`);
  if (input.title) parts.push(`ti:${enc(input.title)}`);
  if (input.abstract) parts.push(`abs:${enc(input.abstract)}`);
  if (input.author) parts.push(`au:${enc(input.author)}`);
  if (input.category) parts.push(`cat:${enc(input.category)}`);
  if (input.fromDate || input.toDate) {
    const lo = input.fromDate ? toArxivDate(input.fromDate, false) : '19910101';
    const hi = input.toDate ? toArxivDate(input.toDate, true) : '20991231';
    parts.push(`submittedDate:[${lo}+TO+${hi}]`);
  }
  if (parts.length === 0) {
    throw new ToolError(
      'Provide at least one of: query, title, abstract, author, category, from_date/to_date, or advanced.',
      { retryable: false },
    );
  }
  return parts.join('+AND+');
}

// ---------------------------------------------------------------------------
// Shapes + summaries
// ---------------------------------------------------------------------------

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

/** Truncate long text for the human-readable summary. */
function truncate(value: string, max = 280): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** A one-line author display ("A, B, C et al."). */
function authorLine(authors: string[]): string {
  return authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '');
}

/** Fetch a single paper's metadata by id (shared by get_paper and save_paper). */
async function fetchPaper(ctx: ToolContext, id: string): Promise<ArxivPaper> {
  const { status, body } = await arxivFetch(ctx, `${ARXIV_API}?id_list=${encodeURIComponent(id)}`, {
    accept: 'application/atom+xml',
  });
  if (status === 400) throw new ToolError(`arXiv rejected the id "${id}".`, { retryable: false });
  const paper = parseFeed(body)[0];
  if (!paper) throw new ToolError(`No arXiv paper found with id "${id}".`, { retryable: false });
  return paper;
}

export default defineMcpServer({
  scopes: ['trove:ingest'],
  tools: [
    {
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
          .describe(
            'Only papers submitted on/after this date. "2026", "2026-03", or "2026-03-01".',
          ),
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
          throw new ToolError('arXiv rejected the search query.', { retryable: false });
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
    },
    {
      name: 'get_paper',
      title: 'arXiv: Get paper',
      description:
        'Fetch a single arXiv paper by its identifier (e.g. "2510.25417" or ' +
        '"2510.25417v1"). Returns the title, authors, full abstract, dates, ' +
        'categories and links. For the full body text, use get_paper_content.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z
          .string()
          .min(1)
          .describe('arXiv paper id, e.g. "2510.25417" (an optional version suffix is allowed).'),
      }),
      output: paperShape,
      async handler(args, ctx) {
        ctx.log('get_paper querying arXiv', { id: args.id });
        const paper = await fetchPaper(ctx, args.id);
        return {
          text:
            `${paper.id} — ${paper.title}\n${paper.authors.join(', ')}\n` +
            `Published ${paper.published.slice(0, 10)} · Updated ${paper.updated.slice(0, 10)} · ` +
            `${paper.categories.join(', ')}\nPDF: ${paper.pdfUrl}\n\n${paper.summary}`,
          structured: paper,
        };
      },
    },
    {
      name: 'get_paper_content',
      title: 'arXiv: Read full text',
      description:
        "Read a paper's full text — parsed from arXiv's HTML (or ar5iv) into titled, " +
        'labelled sections (introduction / methods / results / conclusion …), plus its ' +
        'reference list and the arXiv ids it cites (for citation traversal). Pass a ' +
        '`section` to retrieve just that part (e.g. "results") instead of the whole paper. ' +
        'Not every paper has an HTML version; older PDF-only papers fall back to the abstract.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('arXiv paper id, e.g. "2510.25417".'),
        section: z
          .enum(['introduction', 'background', 'methods', 'results', 'discussion', 'conclusion'])
          .optional()
          .describe('Return only sections of this kind (matched by heading) instead of all.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .default(60_000)
          .describe(
            'Cap on total returned body text (default 60000). Sections are truncated to fit.',
          ),
      }),
      output: z.object({
        id: z.string(),
        title: z.string(),
        htmlAvailable: z.boolean(),
        abstract: z.string(),
        sections: z.array(z.object({ title: z.string(), kind: z.string(), text: z.string() })),
        availableSections: z.array(z.object({ title: z.string(), kind: z.string() })),
        references: z.array(z.string()),
        citedArxivIds: z.array(z.string()),
        truncated: z.boolean(),
      }),
      async handler(args, ctx) {
        const { id, section, maxChars } = args;
        ctx.log('get_paper_content fetching', { id, section });

        const paper = await fetchPaper(ctx, id);
        const html = await fetchPaperHtml(ctx, id);

        if (!html) {
          return {
            text:
              `${paper.id} — ${paper.title}\nNo HTML full text is available for this paper ` +
              `(older submissions are PDF-only). Abstract:\n\n${paper.summary}\nPDF: ${paper.pdfUrl}`,
            structured: {
              id: paper.id,
              title: paper.title,
              htmlAvailable: false,
              abstract: paper.summary,
              sections: [],
              availableSections: [],
              references: [],
              citedArxivIds: [],
              truncated: false,
            },
          };
        }

        const content = parseHtmlContent(html);
        const availableSections = content.sections.map((s) => ({ title: s.title, kind: s.kind }));
        let sections = content.sections;
        if (section) sections = sections.filter((s) => s.kind === section);

        // A requested section the paper doesn't have (common — not every paper
        // uses canonical headings): return the sections it DOES have so the
        // caller can re-request, rather than an empty, silent result.
        if (section && sections.length === 0 && content.sections.length > 0) {
          const list = availableSections.map((s) => `${s.title} (${s.kind})`).join('; ');
          return {
            text: `${paper.id} — ${paper.title}\nNo section is classified as "${section}". Available sections: ${list}. Re-run with one of those kinds, or omit "section" for the whole paper.`,
            structured: {
              id: paper.id,
              title: paper.title,
              htmlAvailable: true,
              abstract: content.abstract || paper.summary,
              sections: [],
              availableSections,
              references: content.references,
              citedArxivIds: content.citedArxivIds,
              truncated: false,
            },
          };
        }

        // Budget the total body text across the selected sections.
        let remaining = maxChars;
        let truncated = false;
        const budgeted = sections.map((s) => {
          if (remaining <= 0) {
            truncated = true;
            return { ...s, text: '' };
          }
          if (s.text.length > remaining) {
            truncated = true;
            const text = `${s.text.slice(0, remaining).trimEnd()}…`;
            remaining = 0;
            return { ...s, text };
          }
          remaining -= s.text.length;
          return s;
        });
        const kept = budgeted.filter((s) => s.text);

        const headerLines = section
          ? `${paper.id} — ${paper.title}\nSection(s): ${section}`
          : `${paper.id} — ${paper.title}\n${authorLine(paper.authors)} · ${kept.length} section(s) · ${content.references.length} reference(s)`;
        const bodyText = kept.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');

        return {
          text: `${headerLines}\n\n${bodyText || content.abstract}${truncated ? '\n\n(text truncated — raise maxChars or request one section)' : ''}`,
          structured: {
            id: paper.id,
            title: paper.title,
            htmlAvailable: true,
            abstract: content.abstract || paper.summary,
            sections: kept,
            availableSections,
            references: content.references,
            citedArxivIds: content.citedArxivIds,
            truncated,
          },
        };
      },
    },
    {
      name: 'save_paper',
      title: 'arXiv: Save to knowledge base',
      description:
        'Save an arXiv paper into your Trove knowledge base so you can find it later with ' +
        'a normal Trove search (no re-fetch). Stores the title, authors, abstract, arXiv id, ' +
        'categories and link; set includeFullText to also index the parsed body sections.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('arXiv paper id to save, e.g. "2510.25417".'),
        includeFullText: z
          .boolean()
          .default(false)
          .describe('Also fetch and index the full body text (when an HTML version exists).'),
      }),
      output: z.object({
        id: z.string(),
        title: z.string(),
        ingested: z.number(),
        includedFullText: z.boolean(),
      }),
      async handler(args, ctx) {
        const { id, includeFullText } = args;
        if (!ctx.trove) {
          throw new ToolError(
            'Saving to your knowledge base needs the trove:ingest permission, which is not enabled for this connection.',
            { retryable: false },
          );
        }

        const paper = await fetchPaper(ctx, id);

        const header =
          `arXiv:${paper.id} · ${paper.categories.join(', ')} · submitted ${paper.published.slice(0, 10)}\n` +
          `Authors: ${paper.authors.join(', ')}\n\nAbstract\n${paper.summary}`;

        let includedFullText = false;
        let bodyText = '';
        if (includeFullText) {
          const html = await fetchPaperHtml(ctx, id);
          if (html) {
            const content = parseHtmlContent(html);
            bodyText = content.sections.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');
            includedFullText = bodyText.length > 0;
          }
        }

        const text = bodyText ? `${header}\n\n${bodyText}` : header;
        ctx.log('save_paper ingesting', { id: paper.id, includedFullText });

        const result = await ctx.trove.ingest([
          { title: paper.title, text, url: paper.arxivUrl, author: paper.authors.join(', ') },
        ]);

        return {
          text:
            `Saved "${paper.title}" (arXiv:${paper.id}) to your knowledge base` +
            `${includedFullText ? ' with full text' : ''}. Find it later with a Trove search.`,
          structured: {
            id: paper.id,
            title: paper.title,
            ingested: result.ingested,
            includedFullText,
          },
        };
      },
    },
  ],
});
