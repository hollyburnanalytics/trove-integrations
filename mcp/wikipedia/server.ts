/**
 * Wikipedia — a no-auth hosted MCP server over the English Wikipedia API
 * (en.wikipedia.org). Article text is licensed CC BY-SA. Two read-only surfaces:
 *  - `search_articles` — relevance-ranked title search, and
 *  - `get_article`     — an article's short description and full plain-text extract.
 * A descriptive User-Agent is sent per Wikimedia's User-Agent policy.
 */
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { getJson } from '../lib/http.ts';

const BASE_URL = 'https://en.wikipedia.org';
const USER_AGENT = 'TroveBot/1.0 (https://github.com/hollyburnanalytics/trove-integrations)';
const MAX_EXTRACT = 12_000;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export default defineMcpServer({
  tools: [
    {
      name: 'search_articles',
      title: 'Wikipedia: Search articles',
      description:
        'Search English Wikipedia by free text. Returns each match with its title, a short ' +
        'description, and the key to pass to get_article.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Search text, e.g. "stoicism".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        articles: z.array(
          z.object({ title: z.string(), key: z.string(), description: z.string().nullable() }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('search_articles', { query, limit });
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        const body = await getJson(`${BASE_URL}/w/rest.php/v1/search/page?${params}`, ctx, {
          service: 'Wikipedia',
          headers: { 'user-agent': USER_AGENT },
        });
        const pages = Array.isArray(body.pages) ? body.pages : [];
        const articles = pages.map((page) => {
          const record = (page ?? {}) as Record<string, unknown>;
          return {
            title: str(record.title),
            key: str(record.key),
            description: str(record.description) || null,
          };
        });
        if (articles.length === 0) {
          return {
            text: `No Wikipedia articles matched "${query}".`,
            structured: { query, count: 0, articles: [] },
          };
        }
        const lines = articles
          .map((a) => `  ${a.title}${a.description ? ` — ${a.description}` : ''}`)
          .join('\n');
        return {
          text: `${articles.length} article(s) for "${query}":\n${lines}`,
          structured: { query, count: articles.length, articles },
        };
      },
    },
    {
      name: 'get_article',
      title: 'Wikipedia: Read an article',
      description:
        'Fetch an English Wikipedia article by title (or the key from search_articles) and ' +
        'return its short description and full plain-text extract. Very long articles are ' +
        'truncated. Content is CC BY-SA — cite Wikipedia and the article URL.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({ title: z.string().min(1).describe('Article title, e.g. "Stoicism".') }),
      output: z.object({
        title: z.string(),
        description: z.string().nullable(),
        extract: z.string(),
        truncated: z.boolean(),
        url: z.string(),
      }),
      async handler(args, ctx) {
        ctx.log('get_article', { title: args.title });
        const params = new URLSearchParams({
          action: 'query',
          prop: 'extracts|description',
          explaintext: '1',
          redirects: '1',
          format: 'json',
          formatversion: '2',
          titles: args.title,
        });
        const body = await getJson(`${BASE_URL}/w/api.php?${params}`, ctx, {
          service: 'Wikipedia',
          headers: { 'user-agent': USER_AGENT },
        });
        const query = (body.query ?? {}) as { pages?: unknown };
        const pages = Array.isArray(query.pages) ? query.pages : [];
        const page = pages[0] as Record<string, unknown> | undefined;
        if (!page || page.missing === true || typeof page.title !== 'string') {
          throw new ToolError(`No Wikipedia article titled "${args.title}".`, { retryable: false });
        }
        const full = str(page.extract);
        const truncated = full.length > MAX_EXTRACT;
        const title = str(page.title);
        const result = {
          title,
          description: str(page.description) || null,
          extract: truncated ? `${full.slice(0, MAX_EXTRACT)}…` : full,
          truncated,
          url: `${BASE_URL}/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
        };
        const text = `${title}${result.description ? ` — ${result.description}` : ''}\n\n${result.extract}`;
        return { text, structured: result };
      },
    },
  ],
});
