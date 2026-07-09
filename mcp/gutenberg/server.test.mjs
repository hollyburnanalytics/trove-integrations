import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/**
 * A raw Gutendex book record, shaped exactly like the fields toBook() reads.
 * Frankenstein (id 84) — the canonical Gutenberg fixture.
 */
const FRANKENSTEIN = {
  id: 84,
  title: 'Frankenstein; Or, The Modern Prometheus',
  authors: [{ name: 'Shelley, Mary Wollstonecraft', birth_year: 1797, death_year: 1851 }],
  translators: [],
  editors: [],
  subjects: ['Horror tales', 'Science fiction', 'Monsters -- Fiction'],
  bookshelves: ['Gothic Fiction', 'Movie Books'],
  languages: ['en'],
  summaries: ['Frankenstein is a Gothic novel about a scientist who creates a creature.'],
  download_count: 12_345,
  formats: {
    'text/plain; charset=utf-8': 'https://www.gutenberg.org/files/84/84-0.txt',
    'text/html': 'https://www.gutenberg.org/ebooks/84.html.images',
    'application/epub+zip': 'https://www.gutenberg.org/ebooks/84.epub3.images',
  },
};

const MOBY_DICK = {
  id: 2701,
  title: 'Moby Dick; Or, The Whale',
  authors: [{ name: 'Melville, Herman', birth_year: 1819, death_year: 1891 }],
  translators: [],
  editors: [],
  subjects: ['Whaling -- Fiction', 'Sea stories'],
  bookshelves: ['Best Books Ever Listings'],
  languages: ['en'],
  summaries: [],
  download_count: 6789,
  formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/files/2701/2701-0.txt' },
};

/** A book body wrapped in the Project Gutenberg license markers the server strips. */
const BOOK_BODY = [
  'The Project Gutenberg eBook of Frankenstein',
  'This header and license boilerplate should be stripped out.',
  '*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***',
  'You will rejoice to hear that no disaster has accompanied the commencement',
  'of an enterprise which you have regarded with such evil forebodings.',
  '*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***',
  'This footer and license boilerplate should also be stripped out.',
].join('\n');

/** The work itself after the markers are stripped and trimmed. */
const STRIPPED =
  'You will rejoice to hear that no disaster has accompanied the commencement\n' +
  'of an enterprise which you have regarded with such evil forebodings.';

/**
 * Build a responder that serves Gutendex metadata for /books/ requests and a
 * text body for everything else (the mirror / gutenberg.org text candidates).
 */
function responder({ meta, metaStatus = 200, body = BOOK_BODY, textStatus = 200 }) {
  return (url) => {
    if (url.includes('gutendex.com')) {
      return metaStatus === 200 ? { json: meta } : { status: metaStatus };
    }
    return textStatus === 200 ? { text: body } : { status: textStatus };
  };
}

describe('gutenberg MCP server', () => {
  it('exposes the four documented tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_book',
      'get_excerpt',
      'search_books',
      'search_inside',
    ]);
  });

  describe('search_books', () => {
    it('returns normalized books from a Gutendex search', async () => {
      const result = await callTool(
        server,
        'search_books',
        { query: 'frankenstein', limit: 10 },
        responder({ meta: { count: 2, results: [FRANKENSTEIN, MOBY_DICK] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.total).toBe(2);
      expect(result.result.structured.count).toBe(2);
      const first = result.result.structured.books[0];
      expect(first.bookId).toBe(84);
      expect(first.title).toContain('Frankenstein');
      expect(first.authors[0].name).toBe('Shelley, Mary Wollstonecraft');
      expect(first.authors[0].birthYear).toBe(1797);
      expect(first.hasFullText).toBe(true);
      expect(first.description).toContain('Gothic novel');
      expect(result.result.text).toContain('[84]');
    });

    it('sends query/topic/language/sort as Gutendex query params', async () => {
      let requested = '';
      await callTool(
        server,
        'search_books',
        { query: 'whale', topic: 'sea stories', language: 'en', sort: 'popular' },
        (url) => {
          if (url.includes('gutendex.com')) {
            requested = url;
            return { json: { count: 0, results: [] } };
          }
          return { text: '' };
        },
      );
      expect(requested).toContain('search=whale');
      expect(requested).toContain('topic=sea+stories');
      expect(requested).toContain('languages=en');
      expect(requested).toContain('sort=popular');
    });

    it('respects the limit when more results are returned', async () => {
      const result = await callTool(
        server,
        'search_books',
        { query: 'fiction', limit: 1 },
        responder({ meta: { count: 99, results: [FRANKENSTEIN, MOBY_DICK] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.total).toBe(99);
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_books',
        { query: 'zzzznotabook' },
        responder({ meta: { count: 0, results: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no gutenberg books/i);
    });

    it('rejects a search with no query, topic, or language (non-retryable)', async () => {
      const result = await callTool(server, 'search_books', {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/at least one/i);
    });

    it('maps a Gutendex 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'search_books',
        { query: 'frankenstein' },
        responder({ meta: {}, metaStatus: 500 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an over-limit argument before fetching', async () => {
      const result = await callTool(server, 'search_books', { query: 'x', limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_book', () => {
    it('returns full metadata plus a derived word count and reading time', async () => {
      const result = await callTool(
        server,
        'get_book',
        { bookId: 84 },
        responder({ meta: FRANKENSTEIN }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.bookId).toBe(84);
      expect(s.title).toContain('Frankenstein');
      expect(s.subjects).toContain('Horror tales');
      expect(s.bookshelves).toContain('Gothic Fiction');
      expect(s.textUrl).toBe('https://www.gutenberg.org/files/84/84-0.txt');
      expect(s.epubUrl).toBe('https://www.gutenberg.org/ebooks/84.epub3.images');
      // 19 words in STRIPPED → readingMinutes = max(1, round(19/238)) = 1.
      expect(s.wordCount).toBe(STRIPPED.split(/\s+/).filter(Boolean).length);
      expect(s.readingMinutes).toBe(1);
    });

    it('still returns metadata when the text body is unavailable (null word count)', async () => {
      const result = await callTool(
        server,
        'get_book',
        { bookId: 84 },
        responder({ meta: FRANKENSTEIN, textStatus: 404 }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.wordCount).toBeNull();
      expect(result.result.structured.readingMinutes).toBeNull();
    });

    it('still returns metadata when the text fetch fails outright (network error)', async () => {
      const result = await callTool(server, 'get_book', { bookId: 84 }, (url) => {
        if (url.includes('gutendex.com')) return { json: FRANKENSTEIN };
        throw new Error('network down');
      });
      expect(result.ok).toBe(true);
      expect(result.result.structured.title).toContain('Frankenstein');
      expect(result.result.structured.wordCount).toBeNull();
      expect(result.result.structured.readingMinutes).toBeNull();
    });

    it('maps a Gutendex 404 to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_book',
        { bookId: 999_999 },
        responder({ meta: {}, metaStatus: 404 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no such/i);
    });

    it('rejects a non-positive bookId before fetching', async () => {
      const result = await callTool(server, 'get_book', { bookId: 0 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('search_inside', () => {
    it('finds a passage, reporting its offset and a context snippet', async () => {
      const result = await callTool(
        server,
        'search_inside',
        { bookId: 84, query: 'disaster' },
        responder({ meta: FRANKENSTEIN }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.totalMatches).toBe(1);
      expect(s.matches).toHaveLength(1);
      expect(s.matches[0].snippet).toContain('disaster');
      expect(s.matches[0].offset).toBe(STRIPPED.indexOf('disaster'));
    });

    it('matches across line breaks and folded punctuation', async () => {
      // "commencement of an enterprise" spans the newline in STRIPPED.
      const result = await callTool(
        server,
        'search_inside',
        { bookId: 84, query: 'commencement of an enterprise' },
        responder({ meta: FRANKENSTEIN }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.totalMatches).toBe(1);
    });

    it('returns zero matches for an absent phrase', async () => {
      const result = await callTool(
        server,
        'search_inside',
        { bookId: 84, query: 'elementary my dear watson' },
        responder({ meta: FRANKENSTEIN }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.totalMatches).toBe(0);
      expect(result.result.text).toMatch(/no matches/i);
    });

    it('errors non-retryably when no plain-text edition can be fetched', async () => {
      const result = await callTool(
        server,
        'search_inside',
        { bookId: 84, query: 'disaster' },
        responder({ meta: FRANKENSTEIN, textStatus: 404 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no plain-text edition/i);
    });

    it('errors retryably when the text source is transiently down (5xx)', async () => {
      const result = await callTool(
        server,
        'search_inside',
        { bookId: 84, query: 'disaster' },
        responder({ meta: FRANKENSTEIN, textStatus: 503 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a too-short query before fetching', async () => {
      const result = await callTool(server, 'search_inside', { bookId: 84, query: 'a' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_excerpt', () => {
    it('returns a slice of the stripped text with continuation metadata', async () => {
      const result = await callTool(
        server,
        'get_excerpt',
        { bookId: 84, offset: 0, length: 200 },
        responder({ meta: FRANKENSTEIN }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.bookId).toBe(84);
      expect(s.offset).toBe(0);
      expect(s.totalLength).toBe(STRIPPED.length);
      // STRIPPED is shorter than 200 chars, so the whole body comes back and
      // there is nothing left to read.
      expect(s.length).toBe(STRIPPED.length);
      expect(s.nextOffset).toBeNull();
      expect(result.result.text).toContain('You will rejoice');
    });

    it('errors non-retryably when the offset is past the end', async () => {
      const result = await callTool(
        server,
        'get_excerpt',
        { bookId: 84, offset: 100_000, length: 2500 },
        responder({ meta: FRANKENSTEIN }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/past the end/i);
    });

    it('errors non-retryably when no plain-text edition exists', async () => {
      const result = await callTool(
        server,
        'get_excerpt',
        { bookId: 84, offset: 0, length: 2500 },
        responder({ meta: FRANKENSTEIN, textStatus: 404 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no plain-text edition/i);
    });

    it('maps a Gutendex 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'get_excerpt',
        { bookId: 84, offset: 0, length: 2500 },
        responder({ meta: {}, metaStatus: 500 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an out-of-range length before fetching', async () => {
      const result = await callTool(server, 'get_excerpt', { bookId: 84, length: 10 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
