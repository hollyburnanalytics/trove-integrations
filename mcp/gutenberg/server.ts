import { defineMcpServer } from '@ontrove/mcp';
import { getBook } from './tools/get-book.ts';
import { getExcerpt } from './tools/get-excerpt.ts';
import { searchBooks } from './tools/search-books.ts';
import { searchInside } from './tools/search-inside.ts';

/**
 * Project Gutenberg — a no-auth hosted MCP server over the freely-licensed
 * Project Gutenberg corpus of ~75,000 public-domain books. Metadata comes from
 * the Gutendex JSON API (gutendex.com); full text is fetched from gutenberg.org.
 *
 * Four read-only surfaces, each in its own module under `tools/`:
 *  - `search_books`  — find public-domain books by keyword / topic / language,
 *  - `get_book`      — metadata + download formats for one book,
 *  - `search_inside` — full-text search *within* a book, returning matching
 *    passages with surrounding context (legal: the text is public domain), and
 *  - `get_excerpt`   — read a windowed slice of a book's text by offset.
 *
 * No API key. Everything Gutenberg distributes is out of copyright, so fetching
 * and searching the full text is unrestricted.
 */
export default defineMcpServer({
  tools: [searchBooks, getBook, searchInside, getExcerpt],
});
