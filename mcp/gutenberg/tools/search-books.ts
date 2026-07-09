import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { GUTENDEX, gutendexErrorMap, toBook } from '../client.ts';
import { authorLabel } from '../format.ts';

/** `search_books` — find public-domain books in the Project Gutenberg corpus. */
export const searchBooks: ToolDefinition = {
  name: 'search_books',
  title: 'Gutenberg: Search public-domain books',
  description:
    'Search the Project Gutenberg corpus (~75,000 free, public-domain books) ' +
    'by keyword (matches author + title), optional topic/subject, language, and ' +
    'author era; sort by popularity. Returns each book with a description, authors ' +
    '(with life years), subjects, curated bookshelves, popularity, and a bookId to ' +
    'pass to get_book / search_inside / get_excerpt.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Keywords over author + title, e.g. "shelley frankenstein".'),
    topic: z.string().optional().describe('Subject or bookshelf, e.g. "horror", "philosophy".'),
    language: z.string().optional().describe('Two-letter language code, e.g. "en", "fr".'),
    sort: z
      .enum(['popular', 'ascending', 'descending'])
      .optional()
      .describe('Order results: "popular" (most-downloaded first) or by id ascending/descending.'),
    authorYearStart: z
      .number()
      .int()
      .optional()
      .describe('Only authors alive on/after this year (negative = BCE), e.g. -100.'),
    authorYearEnd: z
      .number()
      .int()
      .optional()
      .describe('Only authors alive on/before this year, e.g. 200.'),
    limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
  }),
  output: z.object({
    total: z.number(),
    count: z.number(),
    books: z.array(
      z.object({
        bookId: z.number(),
        title: z.string(),
        authors: z.array(
          z.object({
            name: z.string(),
            birthYear: z.number().nullable(),
            deathYear: z.number().nullable(),
          }),
        ),
        description: z.string().nullable(),
        languages: z.array(z.string()),
        subjects: z.array(z.string()),
        bookshelves: z.array(z.string()),
        downloadCount: z.number().nullable(),
        hasFullText: z.boolean(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { query, topic, language, sort, authorYearStart, authorYearEnd, limit } = args;
    if (!query && !topic && !language) {
      throw new ToolError('Provide at least one of query, topic, or language.', {
        retryable: false,
      });
    }
    const params = new URLSearchParams();
    if (query) params.set('search', query);
    if (topic) params.set('topic', topic);
    if (language) params.set('languages', language);
    if (sort) params.set('sort', sort);
    if (authorYearStart !== undefined) params.set('author_year_start', String(authorYearStart));
    if (authorYearEnd !== undefined) params.set('author_year_end', String(authorYearEnd));
    ctx.log('search_books', { query, topic, language, sort, limit });
    const body = (await ctx.fetchJson(`${GUTENDEX}/books/?${params}`, {
      errorMap: gutendexErrorMap,
    })) as Record<string, unknown>;
    const results = Array.isArray(body.results) ? body.results : [];
    const books = results.slice(0, limit).map((r) => {
      const b = toBook(r as Record<string, unknown>);
      return {
        bookId: b.id,
        title: b.title,
        authors: b.authors,
        description: b.summary,
        languages: b.languages,
        subjects: b.subjects.slice(0, 6),
        bookshelves: b.bookshelves,
        downloadCount: b.downloadCount,
        hasFullText: b.textUrl !== null,
      };
    });
    const total = typeof body.count === 'number' ? body.count : books.length;
    if (books.length === 0) {
      return {
        text: 'No Gutenberg books matched.',
        structured: { total: 0, count: 0, books: [] },
      };
    }
    const lines = books
      .map(
        (b) =>
          `  [${b.bookId}] "${b.title}"${b.authors.length ? ` — ${b.authors.map(authorLabel).join(', ')}` : ''}` +
          `${b.downloadCount !== null ? ` · ${b.downloadCount} dl` : ''}`,
      )
      .join('\n');
    return {
      text: `${books.length} of ${total} Gutenberg book(s):\n${lines}`,
      structured: { total, count: books.length, books },
    };
  },
};
