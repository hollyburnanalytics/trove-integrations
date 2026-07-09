import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { fetchBook, fetchBookText } from '../client.ts';

/** `get_excerpt` — read a windowed slice of a book's text by character offset. */
export const getExcerpt: ToolDefinition = {
  name: 'get_excerpt',
  title: 'Gutenberg: Read an excerpt',
  description:
    "Read a windowed slice of a Project Gutenberg book's text by character offset " +
    '(license boilerplate excluded). Offset 0 is the start of the file, which for ' +
    'many books is front matter — title page, contents, illustration lists — before ' +
    'the work itself; use search_inside to jump straight to a passage. Returns the ' +
    'text plus the next offset to continue reading.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    bookId: z.number().int().positive().describe('Gutenberg book id (from search_books).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Character offset to start at (default 0).'),
    length: z
      .number()
      .int()
      .min(200)
      .max(8000)
      .default(2500)
      .describe('Characters to return (200–8000).'),
  }),
  output: z.object({
    bookId: z.number(),
    title: z.string(),
    offset: z.number(),
    length: z.number(),
    totalLength: z.number(),
    nextOffset: z.number().nullable(),
    text: z.string(),
  }),
  async handler(args, ctx) {
    const { bookId, offset, length } = args;
    ctx.log('get_excerpt', { bookId, offset, length });
    const book = await fetchBook(bookId, ctx);
    const text = await fetchBookText(book, ctx);
    if (text === null) {
      throw new ToolError(`Gutenberg book ${bookId} has no plain-text edition to read.`, {
        retryable: false,
      });
    }
    if (offset >= text.length) {
      throw new ToolError(`Offset ${offset} is past the end of the book (${text.length} chars).`, {
        retryable: false,
      });
    }
    const end = Math.min(text.length, offset + length);
    const slice = text.slice(offset, end);
    const nextOffset = end < text.length ? end : null;
    return {
      text: slice,
      structured: {
        bookId,
        title: book.title,
        offset,
        length: slice.length,
        totalLength: text.length,
        nextOffset,
      },
    };
  },
};
