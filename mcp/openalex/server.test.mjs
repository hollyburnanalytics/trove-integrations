import { describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

const KEY = 'test-openalex-key';

const WORKS_BODY = {
  meta: { count: 1234 },
  results: [
    {
      id: 'https://openalex.org/W1',
      display_name: 'Attention Is All You Need',
      publication_year: 2017,
      cited_by_count: 95_000,
      doi: 'https://doi.org/10.5555/3295222.3295349',
      authorships: [
        { author: { display_name: 'Ashish Vaswani' } },
        { author: { display_name: 'Noam Shazeer' } },
      ],
      primary_location: { source: { display_name: 'NeurIPS' } },
    },
    {
      id: 'https://openalex.org/W2',
      display_name: 'BERT',
      publication_year: 2019,
      cited_by_count: 80_000,
      doi: undefined,
      authorships: [{ author: { display_name: 'Jacob Devlin' } }],
      primary_location: {},
    },
  ],
};

const AUTHORS_BODY = {
  meta: { count: 5 },
  results: [
    {
      id: 'https://openalex.org/A1',
      display_name: 'Geoffrey Hinton',
      works_count: 412,
      cited_by_count: 600_000,
      last_known_institutions: [{ display_name: 'University of Toronto' }],
    },
    {
      id: 'https://openalex.org/A2',
      display_name: 'Yann LeCun',
      works_count: 380,
      cited_by_count: 300_000,
      last_known_institutions: [],
    },
  ],
};

describe('openalex MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['search_authors', 'search_works']);
  });

  describe('search_works', () => {
    it('returns ranked works with parsed fields', async () => {
      const result = await callTool(
        server,
        'search_works',
        { query: 'attention' },
        withSecret(KEY, { json: WORKS_BODY }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.query).toBe('attention');
      expect(s.total).toBe(1234);
      expect(s.count).toBe(2);
      expect(s.works).toHaveLength(2);
      expect(s.works[0].title).toBe('Attention Is All You Need');
      expect(s.works[0].authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
      expect(s.works[0].year).toBe(2017);
      expect(s.works[0].venue).toBe('NeurIPS');
      expect(s.works[0].citations).toBe(95_000);
      expect(s.works[0].id).toBe('https://openalex.org/W1');
      // missing doi / venue fall back to null
      expect(s.works[1].doi).toBeNull();
      expect(s.works[1].venue).toBeNull();
      expect(result.result.text).toContain('Attention Is All You Need');
    });

    it('sends the secret api_key, mailto and search params', async () => {
      let requested = '';
      await callTool(
        server,
        'search_works',
        { query: 'transformers', limit: 5 },
        withSecret(KEY, (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: WORKS_BODY };
        }),
      );
      expect(requested).toContain('/works?');
      expect(requested).toContain('search=transformers');
      expect(requested).toContain('per_page=5');
      expect(requested).toContain(`api_key=${KEY}`);
      expect(requested).toContain('mailto=');
    });

    it('applies the fromYear publication-date filter', async () => {
      let requested = '';
      await callTool(
        server,
        'search_works',
        { query: 'graphene', fromYear: 2020 },
        withSecret(KEY, (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: WORKS_BODY };
        }),
      );
      expect(decodeURIComponent(requested)).toContain('filter=from_publication_date:2020-01-01');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_works',
        { query: 'zzzznomatch' },
        withSecret(KEY, { json: { meta: { count: 0 }, results: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.works).toEqual([]);
      expect(result.result.text).toMatch(/no works/i);
    });

    it('maps a 429 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_works',
        { query: 'attention' },
        withSecret(KEY, { status: 429, text: 'rate limited' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 403 to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_works',
        { query: 'attention' },
        withSecret(KEY, { status: 403, text: 'forbidden' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_works',
        { query: 'attention' },
        withSecret(KEY, { status: 500, text: 'boom' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_works', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a limit above the maximum', async () => {
      const result = await callTool(server, 'search_works', { query: 'x', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('search_authors', () => {
    it('returns authors with works count, citations and institution', async () => {
      const result = await callTool(
        server,
        'search_authors',
        { name: 'Geoffrey Hinton' },
        withSecret(KEY, { json: AUTHORS_BODY }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.query).toBe('Geoffrey Hinton');
      expect(s.count).toBe(2);
      expect(s.authors[0].name).toBe('Geoffrey Hinton');
      expect(s.authors[0].worksCount).toBe(412);
      expect(s.authors[0].citations).toBe(600_000);
      expect(s.authors[0].institution).toBe('University of Toronto');
      expect(s.authors[0].id).toBe('https://openalex.org/A1');
      // empty institution list falls back to null
      expect(s.authors[1].institution).toBeNull();
      expect(result.result.text).toContain('University of Toronto');
    });

    it('hits the /authors endpoint with the search name and key', async () => {
      let requested = '';
      await callTool(
        server,
        'search_authors',
        { name: 'LeCun' },
        withSecret(KEY, (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: AUTHORS_BODY };
        }),
      );
      expect(requested).toContain('/authors?');
      expect(requested).toContain('search=LeCun');
      expect(requested).toContain(`api_key=${KEY}`);
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_authors',
        { name: 'Nobody Here' },
        withSecret(KEY, { json: { meta: { count: 0 }, results: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.authors).toEqual([]);
      expect(result.result.text).toMatch(/no authors/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_authors',
        { name: 'Geoffrey Hinton' },
        withSecret(KEY, { status: 500, text: 'boom' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 403 to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_authors',
        { name: 'Geoffrey Hinton' },
        withSecret(KEY, { status: 403, text: 'forbidden' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects an empty name before fetching', async () => {
      const result = await callTool(server, 'search_authors', { name: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
