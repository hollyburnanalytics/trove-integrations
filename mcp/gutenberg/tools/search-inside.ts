import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { fetchBook, fetchBookText } from '../client.ts';
import { foldForSearch, snippetAround } from '../search.ts';

/** `search_inside` — forgiving full-text search within a single book. */
export const searchInside: ToolDefinition = {
  name: 'search_inside',
  title: 'Gutenberg: Search inside a book',
  description:
    'Full-text search within a single Project Gutenberg book. Matching is case-, ' +
    'accent-, and punctuation-insensitive and reads through line breaks, so a ' +
    'quotation typed from memory still matches the typeset source — while the ' +
    "returned snippets preserve the book's exact wording for citation. Each match " +
    'comes with surrounding context and its character offset (pass the offset to ' +
    'get_excerpt to read more), plus a total match count. Use it to locate or verify ' +
    'a quotation, to check whether a phrase actually appears in a work (e.g. ' +
    '"Elementary, my dear Watson" returns zero matches in the Sherlock Holmes canon), ' +
    'or to gauge how often a term occurs. Substring match, not regex or semantic; ' +
    'license boilerplate excluded.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    bookId: z.number().int().positive().describe('Gutenberg book id (from search_books).'),
    query: z.string().min(2).describe('Text to find inside the book, e.g. "the monster".'),
    maxMatches: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(8)
      .describe('Max passages to return (1–25).'),
    context: z
      .number()
      .int()
      .min(40)
      .max(400)
      .default(160)
      .describe('Context chars each side of a match.'),
  }),
  output: z.object({
    bookId: z.number(),
    title: z.string(),
    query: z.string(),
    totalMatches: z.number(),
    matches: z.array(z.object({ offset: z.number(), snippet: z.string() })),
  }),
  async handler(args, ctx) {
    const { bookId, query, maxMatches, context } = args;
    ctx.log('search_inside', { bookId, query, maxMatches });
    const book = await fetchBook(bookId, ctx);
    const text = await fetchBookText(book, ctx);
    if (text === null) {
      throw new ToolError(`Gutenberg book ${bookId} has no plain-text edition to search.`, {
        retryable: false,
      });
    }
    const { folded, map } = foldForSearch(text);
    const needle = foldForSearch(query).folded;
    const matches: { offset: number; snippet: string }[] = [];
    let total = 0;
    for (
      let at = needle ? folded.indexOf(needle) : -1;
      at !== -1;
      at = folded.indexOf(needle, at + needle.length)
    ) {
      total++;
      if (matches.length < maxMatches) {
        const start = map[at];
        const endIdx = map[at + needle.length - 1];
        // Both indices are in range by construction; the guard satisfies noUncheckedIndexedAccess.
        if (start !== undefined && endIdx !== undefined) {
          matches.push({
            offset: start,
            snippet: snippetAround(text, start, endIdx + 1, context),
          });
        }
      }
    }
    if (total === 0) {
      return {
        text: `No matches for "${query}" in "${book.title}".`,
        structured: { bookId, title: book.title, query, totalMatches: 0, matches: [] },
      };
    }
    const lines = matches.map((m) => `  @${m.offset}: ${m.snippet}`).join('\n');
    return {
      text: `${total} match(es) for "${query}" in "${book.title}" (showing ${matches.length}):\n${lines}`,
      structured: { bookId, title: book.title, query, totalMatches: total, matches },
    };
  },
};
