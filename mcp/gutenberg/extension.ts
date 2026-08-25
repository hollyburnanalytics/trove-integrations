import { defineToolkit } from '@ontrove/extend/toolkit';
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
export default defineToolkit({
  id: 'gutenberg',
  name: 'Project Gutenberg',
  description:
    'Search ~75,000 free public-domain books by topic, author era, and popularity; read full text, search inside, and get descriptions, curated shelves, and reading times. No key required.',
  icon: '📜',
  version: '1.0.0',
  secrets: [],
  egress: ['gutendex.com', 'mirror.csclub.uwaterloo.ca', 'www.gutenberg.org'],
  scopes: [],
  visibility: 'shared',
  tools: [searchBooks, getBook, searchInside, getExcerpt],
});
