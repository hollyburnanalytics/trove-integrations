import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// A realistic `search.json` body — only the fields the server's SearchResponse
// schema reads (numFound + docs[].{title,author_name,first_publish_year,isbn,key,cover_i}).
const SEARCH_BODY = {
  numFound: 2,
  docs: [
    {
      title: 'The Hobbit',
      author_name: ['J.R.R. Tolkien'],
      first_publish_year: 1937,
      isbn: ['9780261103283', '0261103288'],
      key: '/works/OL27482W',
      cover_i: 8_323_742,
    },
    {
      title: 'The Lord of the Rings',
      author_name: ['J.R.R. Tolkien'],
      first_publish_year: 1954,
      isbn: ['9780261103252'],
      key: '/works/OL27448W',
      // no cover_i → coverUrl should be null
    },
  ],
};

// A realistic `/api/books?jscmd=data` body — keyed by `ISBN:<isbn>` with the
// fields BookData reads.
const ISBN = '9780199291151';
const BOOK_BODY = {
  [`ISBN:${ISBN}`]: {
    title: 'A Pattern Language',
    authors: [{ name: 'Christopher Alexander' }, { name: 'Sara Ishikawa' }],
    publishers: [{ name: 'Oxford University Press' }],
    publish_date: '1977',
    number_of_pages: 1171,
    subjects: [{ name: 'Architecture' }, { name: 'City planning' }],
    cover: { medium: 'https://covers.openlibrary.org/b/id/12345-M.jpg' },
    url: 'https://openlibrary.org/books/OL123M',
  },
};

describe('openlibrary MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_book', 'search_books']);
  });

  describe('search_books', () => {
    it('returns ranked books with mapped fields', async () => {
      const result = await callTool(
        server,
        'search_books',
        { query: 'tolkien' },
        { json: SEARCH_BODY },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.total).toBe(2);
      expect(result.result.structured.count).toBe(2);
      const [hobbit, lotr] = result.result.structured.books;
      expect(hobbit.title).toBe('The Hobbit');
      expect(hobbit.authors).toEqual(['J.R.R. Tolkien']);
      expect(hobbit.firstPublishYear).toBe(1937);
      expect(hobbit.isbn).toBe('9780261103283');
      expect(hobbit.key).toBe('/works/OL27482W');
      expect(hobbit.coverUrl).toBe('https://covers.openlibrary.org/b/id/8323742-M.jpg');
      // No cover_i → coverUrl null.
      expect(lotr.coverUrl).toBeNull();
      expect(result.result.text).toContain('The Hobbit');
      expect(result.result.text).toContain('J.R.R. Tolkien');
    });

    it('passes query, title, author, and limit into the request URL', async () => {
      let requested = '';
      await callTool(
        server,
        'search_books',
        { query: 'rings', title: 'hobbit', author: 'tolkien', limit: 5 },
        (url) => {
          requested = url;
          return { json: SEARCH_BODY };
        },
      );
      expect(requested).toContain('/search.json?');
      expect(requested).toContain('q=rings');
      expect(requested).toContain('title=hobbit');
      expect(requested).toContain('author=tolkien');
      expect(requested).toContain('limit=5');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_books',
        { query: 'zzznotathing' },
        {
          json: { numFound: 0, docs: [] },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.total).toBe(0);
      expect(result.result.text).toMatch(/no books matched/i);
    });

    it('rejects a request with none of query/title/author (non-retryable tool error)', async () => {
      const result = await callTool(server, 'search_books', {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/at least one of/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(server, 'search_books', { query: 'x' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(server, 'search_books', { query: 'x' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects an out-of-range limit before fetching', async () => {
      const result = await callTool(server, 'search_books', { query: 'x', limit: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_book', () => {
    it('returns full edition details for an ISBN', async () => {
      const result = await callTool(server, 'get_book', { isbn: ISBN }, { json: BOOK_BODY });
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.found).toBe(true);
      expect(s.isbn).toBe(ISBN);
      expect(s.title).toBe('A Pattern Language');
      expect(s.authors).toEqual(['Christopher Alexander', 'Sara Ishikawa']);
      expect(s.publishers).toEqual(['Oxford University Press']);
      expect(s.publishDate).toBe('1977');
      expect(s.numberOfPages).toBe(1171);
      expect(s.subjects).toEqual(['Architecture', 'City planning']);
      expect(s.coverUrl).toBe('https://covers.openlibrary.org/b/id/12345-M.jpg');
      expect(s.url).toBe('https://openlibrary.org/books/OL123M');
      expect(result.result.text).toContain('A Pattern Language');
      expect(result.result.text).toContain('Christopher Alexander');
    });

    it('normalizes a hyphenated ISBN and queries the stripped bibkey', async () => {
      let requested = '';
      const result = await callTool(server, 'get_book', { isbn: '978-0-19-929115-1' }, (url) => {
        requested = url;
        return { json: BOOK_BODY };
      });
      expect(result.ok).toBe(true);
      expect(requested).toContain('/api/books?');
      expect(requested).toContain(`bibkeys=ISBN%3A${ISBN}`);
      expect(result.result.structured.isbn).toBe(ISBN);
    });

    it('reports a missing edition cleanly (found: false)', async () => {
      const result = await callTool(server, 'get_book', { isbn: ISBN }, { json: {} });
      expect(result.ok).toBe(true);
      expect(result.result.structured.found).toBe(false);
      expect(result.result.structured.title).toBeNull();
      expect(result.result.text).toMatch(/no open library edition/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(server, 'get_book', { isbn: ISBN }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(server, 'get_book', { isbn: ISBN }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects an ISBN shorter than 10 chars before fetching', async () => {
      const result = await callTool(server, 'get_book', { isbn: '123' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
