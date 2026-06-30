import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// A realistic HathiTrust Bibliographic API "brief" body: keyed by the
// `${idType}:${idValue}` lookup key, with a `records` object and an `items`
// array. Field names mirror what the handler reads (titles, isbns, orig,
// rightsCode, usRightsString, itemURL, ...).
function briefBody(key, { records = {}, items = [] } = {}) {
  return { [key]: { records, items } };
}

const FULL_VIEW_BODY = briefBody('isbn:9780262033848', {
  records: {
    '000123456': {
      recordURL: 'https://catalog.hathitrust.org/Record/000123456',
      titles: ['Introduction to Algorithms'],
      isbns: ['9780262033848'],
      oclcs: ['311310321'],
      lccns: ['2009005482'],
      publishDates: ['2009'],
    },
  },
  items: [
    {
      htid: 'mdp.39015025315527',
      orig: 'University of Michigan',
      rightsCode: 'pd',
      usRightsString: 'Full view',
      itemURL: 'https://babel.hathitrust.org/cgi/pt?id=mdp.39015025315527',
    },
    {
      htid: 'uc1.b000111222',
      orig: 'University of California',
      rightsCode: 'ic',
      usRightsString: 'Limited (search-only)',
      itemURL: 'https://babel.hathitrust.org/cgi/pt?id=uc1.b000111222',
    },
  ],
});

describe('hathitrust MCP server', () => {
  it('lists the one tool', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['lookup_volume']);
  });

  describe('lookup_volume', () => {
    it('reports holdings and rights for a digitised volume', async () => {
      const result = await callTool(
        server,
        'lookup_volume',
        { isbn: '978-0-262-03384-8' },
        {
          json: FULL_VIEW_BODY,
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.found).toBe(true);
      expect(s.identifier).toBe('isbn:9780262033848');
      expect(s.catalogUrl).toBe('https://catalog.hathitrust.org/Record/000123456');
      expect(s.records).toHaveLength(1);
      expect(s.records[0].title).toBe('Introduction to Algorithms');
      expect(s.items).toHaveLength(2);
      // "pd" rights code → public domain → full view; "ic" → search-only.
      expect(s.items[0].fullView).toBe(true);
      expect(s.items[1].fullView).toBe(false);
      expect(result.result.text).toContain('Introduction to Algorithms');
      expect(result.result.text).toContain('1 full-view');
    });

    it('strips ISBN punctuation when building the lookup key', async () => {
      let requested = '';
      await callTool(server, 'lookup_volume', { isbn: '978-0-262-03384-8' }, (url) => {
        requested = url;
        return { json: FULL_VIEW_BODY };
      });
      expect(requested).toContain('/api/volumes/brief/json/isbn:9780262033848');
    });

    it('preserves htid punctuation literally in the request path', async () => {
      let requested = '';
      const key = 'htid:mdp.39015025315527';
      await callTool(server, 'lookup_volume', { htid: 'mdp.39015025315527' }, (url) => {
        requested = url;
        return { json: briefBody(key) };
      });
      expect(requested).toContain('/api/volumes/brief/json/htid:mdp.39015025315527');
    });

    it('reports a clean "not held" result when no records or items exist', async () => {
      const result = await callTool(
        server,
        'lookup_volume',
        { oclc: '999999999' },
        {
          json: briefBody('oclc:999999999', { records: {}, items: [] }),
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.found).toBe(false);
      expect(result.result.structured.catalogUrl).toBeNull();
      expect(result.result.structured.records).toEqual([]);
      expect(result.result.structured.items).toEqual([]);
      expect(result.result.text).toMatch(/no digitised copy/i);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'lookup_volume',
        { isbn: '9780262033848' },
        {
          status: 404,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'lookup_volume',
        { isbn: '9780262033848' },
        {
          status: 400,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'lookup_volume',
        { isbn: '9780262033848' },
        {
          status: 500,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects when no identifier is provided', async () => {
      const result = await callTool(server, 'lookup_volume', {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/exactly one/i);
    });

    it('rejects when more than one identifier is provided', async () => {
      const result = await callTool(server, 'lookup_volume', {
        isbn: '9780262033848',
        oclc: '311310321',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/exactly one/i);
    });

    it('rejects a non-string identifier before fetching', async () => {
      const result = await callTool(server, 'lookup_volume', { isbn: 9_780_262_033_848 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
