import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// Raw JSON string (served via `{ text }`) so the second page's `description`
// stays on the wire as a real JSON `null` — exercising the null-handling path.
// `JSON.stringify` of a JS object would drop an `undefined` key instead.
const SEARCH_BODY = `{
  "pages": [
    { "id": 1, "key": "Stoicism", "title": "Stoicism", "description": "School of Hellenistic philosophy" },
    { "id": 2, "key": "Stoic", "title": "Stoic", "description": null }
  ]
}`;

const ARTICLE_BODY = {
  query: {
    pages: [
      {
        pageid: 1,
        title: 'Stoicism',
        description: 'School of Hellenistic philosophy',
        extract: 'Stoicism is a school of Hellenistic philosophy founded by Zeno of Citium.',
      },
    ],
  },
};

describe('wikipedia MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_article', 'search_articles']);
  });

  describe('search_articles', () => {
    it('returns ranked matches with title, key and description', async () => {
      const result = await callTool(
        server,
        'search_articles',
        { query: 'stoicism' },
        {
          text: SEARCH_BODY,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.query).toBe('stoicism');
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.articles[0]).toEqual({
        title: 'Stoicism',
        key: 'Stoicism',
        description: 'School of Hellenistic philosophy',
      });
      // a null upstream description normalizes to null, not the string "null"
      expect(result.result.structured.articles[1].description).toBeNull();
      expect(result.result.text).toContain('Stoicism — School of Hellenistic philosophy');
    });

    it('passes the query and limit through to the REST search endpoint', async () => {
      let requested = '';
      await callTool(server, 'search_articles', { query: 'stoicism', limit: 5 }, (url) => {
        requested = url;
        return { text: SEARCH_BODY };
      });
      expect(requested).toContain('/w/rest.php/v1/search/page?');
      expect(requested).toContain('q=stoicism');
      expect(requested).toContain('limit=5');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_articles',
        { query: 'zzzznotathing' },
        {
          json: { pages: [] },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.articles).toEqual([]);
      expect(result.result.text).toMatch(/no wikipedia articles matched/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_articles',
        { query: 'stoicism' },
        {
          status: 500,
          text: 'upstream boom',
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 404 to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_articles',
        { query: 'stoicism' },
        {
          status: 404,
          text: 'not found',
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_articles', { query: 'stoicism', limit: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_articles', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_article', () => {
    it('returns the description, extract and a wiki URL', async () => {
      const result = await callTool(
        server,
        'get_article',
        { title: 'Stoicism' },
        {
          json: ARTICLE_BODY,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.title).toBe('Stoicism');
      expect(result.result.structured.description).toBe('School of Hellenistic philosophy');
      expect(result.result.structured.truncated).toBe(false);
      expect(result.result.structured.extract).toContain('Zeno of Citium');
      expect(result.result.structured.url).toBe('https://en.wikipedia.org/wiki/Stoicism');
      expect(result.result.text).toContain('Stoicism — School of Hellenistic philosophy');
    });

    it('encodes spaces as underscores in the article URL', async () => {
      const result = await callTool(
        server,
        'get_article',
        { title: 'Marcus Aurelius' },
        {
          json: {
            query: {
              pages: [
                { title: 'Marcus Aurelius', extract: 'Roman emperor.', description: 'emperor' },
              ],
            },
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.url).toBe('https://en.wikipedia.org/wiki/Marcus_Aurelius');
    });

    it('truncates very long extracts and flags it', async () => {
      const long = 'a'.repeat(20_000);
      const result = await callTool(
        server,
        'get_article',
        { title: 'Long' },
        {
          // Raw JSON so `description` arrives as a real `null` (see SEARCH_BODY).
          text: `{ "query": { "pages": [{ "title": "Long", "extract": ${JSON.stringify(long)}, "description": null }] } }`,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.structured.extract.length).toBe(12_001); // 12_000 chars + ellipsis
      expect(result.result.structured.extract.endsWith('…')).toBe(true);
      expect(result.result.structured.description).toBeNull();
    });

    it('throws a non-retryable error when the page is missing', async () => {
      const result = await callTool(
        server,
        'get_article',
        { title: 'Nonexistent Page' },
        {
          json: { query: { pages: [{ title: 'Nonexistent Page', missing: true }] } },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no wikipedia article/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'get_article',
        { title: 'Stoicism' },
        {
          status: 500,
          text: 'upstream boom',
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty title before fetching', async () => {
      const result = await callTool(server, 'get_article', { title: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
