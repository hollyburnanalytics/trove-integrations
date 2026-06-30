import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** Build a single Atom <entry> block in the shape arXiv emits. */
function entry({
  id = '2510.25417',
  title = 'A Study of Diffusion Models',
  authors = ['Ada Lovelace', 'Alan Turing'],
  summary = 'We present a thorough study of diffusion models.',
  published = '2025-10-29T12:00:00Z',
  updated = '2025-10-30T08:00:00Z',
  categories = ['cs.LG', 'stat.ML'],
} = {}) {
  const authorXml = authors.map((n) => `<author><name>${n}</name></author>`).join('\n');
  const catXml = categories
    .map((c) => `<category term="${c}" scheme="http://arxiv.org/schemas/atom"/>`)
    .join('\n');
  return `<entry>
    <id>http://arxiv.org/abs/${id}v1</id>
    <updated>${updated}</updated>
    <published>${published}</published>
    <title>${title}</title>
    <summary>${summary}</summary>
    ${authorXml}
    <link href="http://arxiv.org/abs/${id}v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${id}v1" rel="related" type="application/pdf"/>
    ${catXml}
  </entry>`;
}

/** Wrap entry blocks in an Atom feed. */
function feed(...entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  ${entries.join('\n')}
</feed>`;
}

describe('arxiv MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_paper', 'search_papers']);
  });

  describe('search_papers', () => {
    it('returns parsed papers for a query', async () => {
      const xml = feed(
        entry({ id: '2510.25417', title: 'Diffusion Models Survey' }),
        entry({
          id: '2510.11111',
          title: 'Second Paper',
          authors: ['Grace Hopper'],
          categories: ['cs.AI'],
        }),
      );
      const result = await callTool(
        server,
        'search_papers',
        { query: 'diffusion models', category: 'cs.LG', maxResults: 10 },
        { text: xml },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      const [first] = result.result.structured.papers;
      expect(first.id).toBe('2510.25417');
      expect(first.title).toBe('Diffusion Models Survey');
      expect(first.authors).toEqual(['Ada Lovelace', 'Alan Turing']);
      expect(first.categories).toEqual(['cs.LG', 'stat.ML']);
      expect(first.pdfUrl).toContain('arxiv.org/pdf/2510.25417v1');
      expect(first.arxivUrl).toBe('https://arxiv.org/abs/2510.25417');
      expect(result.result.text).toContain('Diffusion Models Survey');
    });

    it('builds the search_query with the category and literal +AND+ joiner', async () => {
      let requested = '';
      await callTool(
        server,
        'search_papers',
        { query: 'graph neural', category: 'cs.LG' },
        (url) => {
          requested = url;
          return { text: feed(entry()) };
        },
      );
      expect(requested).toContain('search_query=all:graph%20neural+AND+cat:cs.LG');
      expect(requested).toContain('sortBy=relevance');
      expect(requested).toContain('sortOrder=descending');
    });

    it('maps the sortBy label to the arXiv sortBy value', async () => {
      let requested = '';
      await callTool(server, 'search_papers', { query: 'x', sortBy: 'lastUpdated' }, (url) => {
        requested = url;
        return { text: feed(entry()) };
      });
      expect(requested).toContain('sortBy=lastUpdatedDate');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'nonexistent topic' },
        {
          text: feed(),
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.papers).toEqual([]);
      expect(result.result.text).toMatch(/no arxiv papers found/i);
    });

    it('maps a 400 to a non-retryable error', async () => {
      const result = await callTool(server, 'search_papers', { query: 'bad' }, { status: 400 });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(server, 'search_papers', { query: 'down' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_papers', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects maxResults above the allowed maximum', async () => {
      const result = await callTool(server, 'search_papers', { query: 'x', maxResults: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_paper', () => {
    it('returns a single paper by id', async () => {
      const xml = feed(
        entry({
          id: '2510.25417',
          title: 'A Single Paper',
          authors: ['Ada Lovelace'],
          summary: 'The full abstract text.',
          categories: ['cs.LG'],
        }),
      );
      const result = await callTool(server, 'get_paper', { id: '2510.25417' }, { text: xml });
      expect(result.ok).toBe(true);
      expect(result.result.structured.id).toBe('2510.25417');
      expect(result.result.structured.title).toBe('A Single Paper');
      expect(result.result.structured.summary).toBe('The full abstract text.');
      expect(result.result.text).toContain('A Single Paper');
      expect(result.result.text).toContain('PDF: http://arxiv.org/pdf/2510.25417v1');
    });

    it('encodes the id into the id_list query parameter', async () => {
      let requested = '';
      await callTool(server, 'get_paper', { id: '2510.25417v2' }, (url) => {
        requested = url;
        return { text: feed(entry({ id: '2510.25417' })) };
      });
      expect(requested).toContain('id_list=2510.25417v2');
    });

    it('maps an empty feed to a non-retryable not-found error', async () => {
      const result = await callTool(server, 'get_paper', { id: '0000.00000' }, { text: feed() });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.error).toMatch(/no arxiv paper found/i);
    });

    it('maps a 400 to a non-retryable error', async () => {
      const result = await callTool(server, 'get_paper', { id: 'garbage' }, { status: 400 });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('maps a 503 to a retryable error', async () => {
      const result = await callTool(server, 'get_paper', { id: '2510.25417' }, { status: 503 });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('rejects an empty id before fetching', async () => {
      const result = await callTool(server, 'get_paper', { id: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
