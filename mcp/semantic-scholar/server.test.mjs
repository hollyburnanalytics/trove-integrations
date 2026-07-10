import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** A realistic raw paper as returned by the Semantic Scholar Graph API. */
const ATTENTION_PAPER = {
  paperId: '204e3073870fae3d05bcbc2f6a8e263d9b72e776',
  externalIds: { DOI: '10.5555/3295222.3295349', ArXiv: '1706.03762' },
  title: 'Attention Is All You Need',
  abstract:
    'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.',
  year: 2017,
  publicationDate: '2017-06-12',
  authors: [
    { authorId: '1', name: 'Ashish Vaswani' },
    { authorId: '2', name: 'Noam Shazeer' },
  ],
  citationCount: 95_000,
  influentialCitationCount: 12_000,
  openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762.pdf' },
  venue: 'NeurIPS',
  publicationTypes: ['JournalArticle'],
  url: 'https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776',
};

/**
 * A minimal paper exercising the null-coalescing normalizer branches. Defined
 * as a raw JSON string (served via `{ text }`) so the nullable fields stay on
 * the wire as real JSON `null`s — `JSON.stringify` of a JS object would drop
 * any `undefined` keys, changing the wire shape under test.
 */
const SPARSE_PAPER_JSON = `{
  "paperId": "abc123",
  "externalIds": null,
  "title": null,
  "abstract": null,
  "year": null,
  "publicationDate": null,
  "authors": null,
  "citationCount": null,
  "influentialCitationCount": null,
  "openAccessPdf": null,
  "venue": "",
  "publicationTypes": null,
  "url": null
}`;

describe('semantic-scholar MCP server', () => {
  it('lists the four tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_paper',
      'get_paper_citations',
      'get_paper_references',
      'search_papers',
    ]);
  });

  describe('search_papers', () => {
    it('returns normalized papers with totals', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'transformers', limit: 5 },
        { json: { data: [ATTENTION_PAPER], total: 4242 } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.total).toBe(4242);
      expect(result.result.structured.count).toBe(1);
      const paper = result.result.structured.papers[0];
      expect(paper.title).toBe('Attention Is All You Need');
      expect(paper.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
      expect(paper.doi).toBe('10.5555/3295222.3295349');
      expect(paper.arxivId).toBe('1706.03762');
      expect(paper.citationCount).toBe(95_000);
      expect(result.result.text).toContain('Attention Is All You Need');
      expect(result.result.text).toContain('et al.');
    });

    it('passes query, year and minCitationCount filters in the request', async () => {
      let requested = '';
      await callTool(
        server,
        'search_papers',
        { query: 'graph neural networks', limit: 3, year: '2019-2023', minCitationCount: 50 },
        (url) => {
          requested = url;
          return { json: { data: [ATTENTION_PAPER], total: 1 } };
        },
      );
      expect(requested).toContain('/paper/search');
      expect(requested).toContain('query=graph+neural+networks');
      expect(requested).toContain('year=2019-2023');
      expect(requested).toContain('minCitationCount=50');
      expect(requested).toContain('limit=3');
    });

    it('reports no matches cleanly', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'asdfqwerty', limit: 10 },
        { json: { data: [], total: 0 } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.papers).toEqual([]);
      expect(result.result.text).toMatch(/no papers found/i);
    });

    it('maps a 429 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'x429', limit: 5 },
        { status: 429 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate.?limit/i);
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'x400', limit: 5 },
        { status: 400 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'x500', limit: 5 },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_papers', { query: '', limit: 5 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a limit above 100 before fetching', async () => {
      const result = await callTool(server, 'search_papers', { query: 'x', limit: 101 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_paper', () => {
    it('returns full metadata and abstract', async () => {
      const result = await callTool(
        server,
        'get_paper',
        { id: 'arXiv:1706.03762' },
        { json: ATTENTION_PAPER },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.paperId).toBe(ATTENTION_PAPER.paperId);
      expect(result.result.structured.openAccessPdfUrl).toBe(
        'https://arxiv.org/pdf/1706.03762.pdf',
      );
      expect(result.result.text).toContain('Attention Is All You Need');
      expect(result.result.text).toContain('Ashish Vaswani, Noam Shazeer');
      expect(result.result.text).toContain('Venue: NeurIPS');
    });

    it('normalizes a sparse paper with sensible fallbacks', async () => {
      const result = await callTool(
        server,
        'get_paper',
        { id: 'abc123' },
        { text: SPARSE_PAPER_JSON },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.title).toBe('Untitled');
      expect(s.authors).toEqual([]);
      expect(s.citationCount).toBe(0);
      expect(s.influentialCitationCount).toBe(0);
      expect(s.doi).toBeNull();
      expect(s.arxivId).toBeNull();
      expect(s.venue).toBeNull();
      expect(s.url).toBe('https://www.semanticscholar.org/paper/abc123');
      expect(result.result.text).toContain('Unknown authors');
      expect(result.result.text).toContain('No abstract available');
    });

    it('maps a 404 to a non-retryable not-found error', async () => {
      const result = await callTool(server, 'get_paper', { id: 'DOI:bogus' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no paper found/i);
    });

    it('rejects an empty id before fetching', async () => {
      const result = await callTool(server, 'get_paper', { id: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_paper_citations', () => {
    it('returns papers that cite the target, unwrapped from citingPaper', async () => {
      const result = await callTool(
        server,
        'get_paper_citations',
        { id: ATTENTION_PAPER.paperId, limit: 5 },
        { json: { data: [{ citingPaper: ATTENTION_PAPER }] } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.papers[0].paperId).toBe(ATTENTION_PAPER.paperId);
      expect(result.result.text).toMatch(/citing/i);
    });

    it('reports no citations cleanly', async () => {
      const result = await callTool(
        server,
        'get_paper_citations',
        { id: 'abc123', limit: 5 },
        { json: { data: [] } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no citations/i);
    });

    it('maps a 404 to a non-retryable not-found error', async () => {
      const result = await callTool(
        server,
        'get_paper_citations',
        { id: 'missing', limit: 5 },
        { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no paper found/i);
    });

    it('rejects a non-integer limit before fetching', async () => {
      const result = await callTool(server, 'get_paper_citations', { id: 'abc123', limit: 2.5 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_paper_references', () => {
    it('returns referenced papers, unwrapped from citedPaper', async () => {
      const result = await callTool(
        server,
        'get_paper_references',
        { id: ATTENTION_PAPER.paperId, limit: 5 },
        { json: { data: [{ citedPaper: ATTENTION_PAPER }] } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.papers[0].title).toBe('Attention Is All You Need');
      expect(result.result.text).toMatch(/reference/i);
    });

    it('reports no references cleanly', async () => {
      const result = await callTool(
        server,
        'get_paper_references',
        { id: 'abc123', limit: 5 },
        { json: { data: [] } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no references/i);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'get_paper_references',
        { id: 'err500', limit: 5 },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a missing id before fetching', async () => {
      const result = await callTool(server, 'get_paper_references', { limit: 5 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
