import { type ToolDefinition, z } from '@ontrove/mcp';
import { fetchBook, fetchBookText } from '../client.ts';
import { authorLabel } from '../format.ts';

/** `get_book` — full metadata for one Project Gutenberg book by bookId. */
export const getBook: ToolDefinition = {
  name: 'get_book',
  title: 'Gutenberg: Get book details',
  description:
    'Fetch full metadata for one Project Gutenberg book by bookId: title, authors ' +
    '(with life years), translators/editors, a description, subjects, curated ' +
    'bookshelves, popularity, an estimated word count and reading time, and the ' +
    'plain-text / HTML / EPUB URLs.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    bookId: z.number().int().positive().describe('Gutenberg book id (from search_books).'),
  }),
  output: z.object({
    bookId: z.number(),
    title: z.string(),
    authors: z.array(
      z.object({
        name: z.string(),
        birthYear: z.number().nullable(),
        deathYear: z.number().nullable(),
      }),
    ),
    translators: z.array(z.string()),
    editors: z.array(z.string()),
    description: z.string().nullable(),
    subjects: z.array(z.string()),
    bookshelves: z.array(z.string()),
    languages: z.array(z.string()),
    downloadCount: z.number().nullable(),
    wordCount: z.number().nullable(),
    readingMinutes: z.number().nullable(),
    textUrl: z.string().nullable(),
    htmlUrl: z.string().nullable(),
    epubUrl: z.string().nullable(),
  }),
  async handler(args, ctx) {
    ctx.log('get_book', { bookId: args.bookId });
    const b = await fetchBook(args.bookId, ctx);
    // Length is not in the metadata, so derive it from the body (best-effort:
    // a fetch failure just leaves wordCount/readingMinutes null).
    let wordCount: number | null = null;
    const text = await fetchBookText(b, ctx).catch(() => null);
    if (text) wordCount = text.split(/\s+/).filter(Boolean).length;
    const readingMinutes = wordCount === null ? null : Math.max(1, Math.round(wordCount / 238));
    return {
      text:
        `[${b.id}] "${b.title}"${b.authors.length ? ` — ${b.authors.map(authorLabel).join(', ')}` : ''}\n` +
        `  ${b.languages.join('/') || '?'} · ${b.downloadCount ?? '?'} downloads` +
        `${readingMinutes ? ` · ~${readingMinutes} min read` : ''}` +
        `${b.summary ? `\n  ${b.summary}` : ''}` +
        `${b.bookshelves.length ? `\n  Shelves: ${b.bookshelves.join('; ')}` : ''}` +
        `${b.textUrl ? `\n  Full text: ${b.textUrl}` : ''}`,
      structured: {
        bookId: b.id,
        title: b.title,
        authors: b.authors,
        translators: b.translators,
        editors: b.editors,
        description: b.summary,
        subjects: b.subjects,
        bookshelves: b.bookshelves,
        languages: b.languages,
        downloadCount: b.downloadCount,
        wordCount,
        readingMinutes,
        textUrl: b.textUrl,
        htmlUrl: b.htmlUrl,
        epubUrl: b.epubUrl,
      },
    };
  },
};
