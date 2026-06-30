import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** Two current MPs in the OpenParliament `/politicians/` wire shape. */
const POLITICIANS = {
  objects: [
    {
      name: 'Chrystia Freeland',
      url: '/politicians/chrystia-freeland/',
      current_party: { short_name: { en: 'Liberal' } },
      current_riding: { name: { en: 'University—Rosedale' }, province: 'ON' },
    },
    {
      name: 'Pierre Poilievre',
      url: '/politicians/pierre-poilievre/',
      current_party: { short_name: { en: 'Conservative' } },
      current_riding: { name: { en: 'Carleton' }, province: 'ON' },
    },
  ],
};

/** One Hansard statement in the `/speeches/` wire shape. */
const SPEECHES = {
  objects: [
    {
      time: '2026-05-01T14:30:00',
      attribution: { en: 'Hon. Chrystia Freeland' },
      content: { en: '<p>Mr.&nbsp;Speaker, I rise today to address the budget.</p>' },
      url: '/debates/2026/5/1/chrystia-freeland-1/',
    },
  ],
};

/** Two bills in the `/bills/` wire shape. */
const BILLS = {
  objects: [
    {
      number: 'C-11',
      name: { en: 'Online Streaming Act' },
      session: '44-1',
      introduced: '2022-02-02',
      url: '/bills/44-1/C-11/',
    },
    {
      number: 'C-5',
      name: { en: 'An Act respecting certain measures' },
      session: '44-1',
      introduced: '2021-12-01',
      url: '/bills/44-1/C-5/',
    },
  ],
};

describe('openparliament MCP server', () => {
  it('lists the three tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'find_mp',
      'mp_speeches',
      'search_bills',
    ]);
  });

  describe('find_mp', () => {
    it('resolves a name substring to one MP with party/riding/slug', async () => {
      const result = await callTool(server, 'find_mp', { name: 'Freeland' }, { json: POLITICIANS });
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.query).toBe('Freeland');
      expect(s.count).toBe(1);
      expect(s.members).toHaveLength(1);
      expect(s.members[0]).toEqual({
        name: 'Chrystia Freeland',
        slug: 'chrystia-freeland',
        party: 'Liberal',
        riding: 'University—Rosedale',
        province: 'ON',
        url: 'https://openparliament.ca/politicians/chrystia-freeland/',
      });
      expect(result.result.text).toContain('Freeland');
      expect(result.result.text).toContain('Liberal');
    });

    it('requests the politicians list as JSON', async () => {
      let requested = '';
      await callTool(server, 'find_mp', { name: 'Freeland' }, (url) => {
        requested = url;
        return { json: POLITICIANS };
      });
      expect(requested).toContain('https://api.openparliament.ca/politicians/');
      expect(requested).toContain('format=json');
    });

    it('reports no match cleanly without inventing members', async () => {
      const result = await callTool(server, 'find_mp', { name: 'Nobody' }, { json: POLITICIANS });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.members).toEqual([]);
      expect(result.result.text).toMatch(/no current mp/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'find_mp', { name: 'Freeland' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a limit above the allowed maximum', async () => {
      const result = await callTool(server, 'find_mp', { name: 'Freeland', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty name', async () => {
      const result = await callTool(server, 'find_mp', { name: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('mp_speeches', () => {
    it('treats a hyphenated slug as a slug and returns statements', async () => {
      const result = await callTool(
        server,
        'mp_speeches',
        { mp: 'chrystia-freeland' },
        { json: SPEECHES },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.slug).toBe('chrystia-freeland');
      expect(s.count).toBe(1);
      expect(s.statements[0].date).toBe('2026-05-01');
      expect(s.statements[0].speaker).toBe('Hon. Chrystia Freeland');
      // HTML tags + entities stripped to plain text.
      expect(s.statements[0].excerpt).toBe('Mr. Speaker, I rise today to address the budget.');
      expect(s.statements[0].excerpt).not.toContain('<');
      expect(s.statements[0].url).toBe(
        'https://openparliament.ca/debates/2026/5/1/chrystia-freeland-1/',
      );
    });

    it('passes the resolved slug as the politician filter on /speeches/', async () => {
      let speechUrl = '';
      await callTool(server, 'mp_speeches', { mp: 'chrystia-freeland' }, (url) => {
        if (url.includes('/speeches/')) speechUrl = url;
        return { json: SPEECHES };
      });
      expect(speechUrl).toContain('https://api.openparliament.ca/speeches/');
      expect(speechUrl).toContain('politician=chrystia-freeland');
    });

    it('resolves a free-text name via the politicians list', async () => {
      const result = await callTool(server, 'mp_speeches', { mp: 'Freeland' }, (url) => {
        if (url.includes('/speeches/')) return { json: SPEECHES };
        return { json: POLITICIANS };
      });
      expect(result.ok).toBe(true);
      expect(result.result.structured.mp).toBe('Chrystia Freeland');
      expect(result.result.structured.slug).toBe('chrystia-freeland');
      expect(result.result.structured.count).toBe(1);
    });

    it('throws a non-retryable error when no MP matches the name', async () => {
      const result = await callTool(
        server,
        'mp_speeches',
        { mp: 'Nobody Here' },
        {
          json: { objects: [] },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no current mp/i);
    });

    it('reports an empty statement list cleanly', async () => {
      const result = await callTool(
        server,
        'mp_speeches',
        { mp: 'chrystia-freeland' },
        {
          json: { objects: [] },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no statements/i);
    });

    it('maps a 500 on /speeches/ to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'mp_speeches',
        { mp: 'chrystia-freeland' },
        {
          status: 500,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a limit above the allowed maximum', async () => {
      const result = await callTool(server, 'mp_speeches', { mp: 'chrystia-freeland', limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('search_bills', () => {
    it('matches a query against the bill title', async () => {
      const result = await callTool(
        server,
        'search_bills',
        { query: 'streaming' },
        { json: BILLS },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.count).toBe(1);
      expect(s.bills[0]).toEqual({
        number: 'C-11',
        name: 'Online Streaming Act',
        session: '44-1',
        introduced: '2022-02-02',
        url: 'https://openparliament.ca/bills/44-1/C-11/',
      });
      expect(result.result.text).toContain('C-11');
    });

    it('matches a query against the bill number', async () => {
      const result = await callTool(server, 'search_bills', { query: 'c-5' }, { json: BILLS });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.bills[0].number).toBe('C-5');
    });

    it('returns all bills when no query is given', async () => {
      const result = await callTool(server, 'search_bills', {}, { json: BILLS });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
    });

    it('passes a session through to the upstream query', async () => {
      let requested = '';
      await callTool(server, 'search_bills', { session: '44-1' }, (url) => {
        requested = url;
        return { json: BILLS };
      });
      expect(requested).toContain('https://api.openparliament.ca/bills/');
      expect(requested).toContain('session=44-1');
    });

    it('reports no matches cleanly', async () => {
      const result = await callTool(server, 'search_bills', { query: 'zzzz' }, { json: BILLS });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no bills/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_bills',
        { query: 'streaming' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a limit above the allowed maximum', async () => {
      const result = await callTool(server, 'search_bills', { limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
