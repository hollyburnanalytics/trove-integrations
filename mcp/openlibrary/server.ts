import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * Open Library — a no-auth hosted MCP server over the free Open Library API
 * (openlibrary.org). Two read-only surfaces:
 *  - `search_books` — full-text / title / author search over the catalogue, and
 *  - `get_book` — full edition details for an ISBN.
 *
 * No API key is required. Cover image URLs are returned (not fetched) so the
 * single `openlibrary.org` egress host suffices. Responses are parsed and typed
 * by `ctx.fetchJson` against the lenient schemas below — no manual guards.
 */

/** Base host for the Open Library API. */
const BASE_URL = 'https://openlibrary.org';

/** A `search.json` response (lenient — every field defaulted/optional). */
const SearchResponse = z.object({
  numFound: z.number().default(0),
  docs: z
    .array(
      z.object({
        title: z.string().default('Untitled'),
        author_name: z.array(z.string()).default([]),
        first_publish_year: z.number().nullish(),
        isbn: z.array(z.string()).default([]),
        key: z.string().nullish(),
        cover_i: z.number().nullish(),
      }),
    )
    .default([]),
});

/** A named entity (`{ name }`) as the books data API returns authors/publishers/subjects. */
const Named = z.object({ name: z.string() });

/** A single `/api/books?jscmd=data` edition record. */
const BookData = z.object({
  title: z.string().nullish(),
  authors: z.array(Named).default([]),
  publishers: z.array(Named).default([]),
  publish_date: z.string().nullish(),
  number_of_pages: z.number().nullish(),
  subjects: z.array(Named).default([]),
  cover: z.object({ medium: z.string().nullish() }).nullish(),
  url: z.string().nullish(),
});

export default defineMcpServer({
  tools: [
    {
      name: 'search_books',
      title: 'Books: Search',
      description:
        'Search the Open Library catalogue by free text, title, and/or author. ' +
        'Returns ranked works with title, author(s), first-published year, an ' +
        'example ISBN, the Open Library work key, and a cover image URL.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().optional().describe('Free-text query across title/author/etc.'),
        title: z.string().optional().describe('Restrict to a title.'),
        author: z.string().optional().describe('Restrict to an author.'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
      }),
      output: z.object({
        total: z.number(),
        count: z.number(),
        books: z.array(
          z.object({
            title: z.string(),
            authors: z.array(z.string()),
            firstPublishYear: z.number().nullable(),
            isbn: z.string().nullable(),
            key: z.string().nullable(),
            coverUrl: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, title, author, limit } = args;
        if (!query && !title && !author) {
          throw new ToolError('Provide at least one of query, title, or author.', {
            retryable: false,
          });
        }
        const params = new URLSearchParams({
          limit: String(limit),
          fields: 'title,author_name,first_publish_year,isbn,key,cover_i',
        });
        if (query) params.set('q', query);
        if (title) params.set('title', title);
        if (author) params.set('author', author);
        ctx.log('search_books', { query, title, author, limit });
        const body = await ctx.fetchJson(`${BASE_URL}/search.json?${params}`, {
          schema: SearchResponse,
        });

        const books = body.docs.map((d) => ({
          title: d.title,
          authors: d.author_name,
          firstPublishYear: d.first_publish_year ?? null,
          isbn: d.isbn[0] ?? null,
          key: d.key ?? null,
          coverUrl:
            d.cover_i != null ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
        }));
        if (books.length === 0) {
          return { text: 'No books matched.', structured: { total: 0, count: 0, books: [] } };
        }
        const lines = books
          .map(
            (b) =>
              `  "${b.title}"${b.authors.length ? ` — ${b.authors.join(', ')}` : ''}${b.firstPublishYear ? ` (${b.firstPublishYear})` : ''}`,
          )
          .join('\n');
        return {
          text: `${books.length} of ${body.numFound} result(s):\n${lines}`,
          structured: { total: body.numFound, count: books.length, books },
        };
      },
    },
    {
      name: 'get_book',
      title: 'Books: Get by ISBN',
      description:
        'Fetch full edition details for an ISBN (10 or 13 digit): title, authors, ' +
        'publisher, publish date, page count, subjects, and cover.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        isbn: z.string().min(10).describe('ISBN-10 or ISBN-13, e.g. "9780199291151".'),
      }),
      output: z.object({
        isbn: z.string(),
        found: z.boolean(),
        title: z.string().nullable(),
        authors: z.array(z.string()),
        publishers: z.array(z.string()),
        publishDate: z.string().nullable(),
        numberOfPages: z.number().nullable(),
        subjects: z.array(z.string()),
        coverUrl: z.string().nullable(),
        url: z.string().nullable(),
      }),
      async handler(args, ctx) {
        const isbn = args.isbn.replace(/[^0-9Xx]/g, '');
        ctx.log('get_book', { isbn });
        const params = new URLSearchParams({
          bibkeys: `ISBN:${isbn}`,
          format: 'json',
          jscmd: 'data',
        });
        const body = await ctx.fetchJson(`${BASE_URL}/api/books?${params}`, {
          schema: z.record(z.string(), BookData),
        });
        const entry = body[`ISBN:${isbn}`];
        if (!entry) {
          return {
            text: `No Open Library edition found for ISBN ${isbn}.`,
            structured: {
              isbn,
              found: false,
              title: null,
              authors: [],
              publishers: [],
              publishDate: null,
              numberOfPages: null,
              subjects: [],
              coverUrl: null,
              url: null,
            },
          };
        }
        const result = {
          isbn,
          found: true,
          title: entry.title ?? null,
          authors: entry.authors.map((a) => a.name),
          publishers: entry.publishers.map((p) => p.name),
          publishDate: entry.publish_date ?? null,
          numberOfPages: entry.number_of_pages ?? null,
          subjects: entry.subjects.map((s) => s.name).slice(0, 12),
          coverUrl: entry.cover?.medium ?? null,
          url: entry.url ?? null,
        };
        return {
          text:
            `"${result.title ?? 'Untitled'}"${result.authors.length ? ` — ${result.authors.join(', ')}` : ''}\n` +
            `  ${result.publishers.join(', ') || '?'}, ${result.publishDate ?? '?'}` +
            `${result.numberOfPages ? `, ${result.numberOfPages} pages` : ''}`,
          structured: result,
        };
      },
    },
  ],
});
