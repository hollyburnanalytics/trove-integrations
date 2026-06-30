import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const PERMITS = [
  {
    caseNumber: 'BLD2020-00231',
    date: '2020-03-14T00:00:00',
    status: 'Issued',
    address: '2298 HAZELLYNN PL',
    workclass: 'New single family building',
    value: 850_000,
    contact: 'Acme Construction Ltd.',
  },
  {
    caseNumber: 'ELEC2019-00045',
    date: '2019-11-02T00:00:00',
    status: 'Closed',
    address: '2298 HAZELLYNN PL',
    workclass: 'Electrical permit',
    value: 0,
    contact: 'Owner',
  },
];

describe('dnv-permits MCP server', () => {
  it('lists the three tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'recent_permits',
      'search_permits',
      'suggest_addresses',
    ]);
  });

  describe('search_permits', () => {
    it('returns permits at an address', async () => {
      const result = await callTool(
        server,
        'search_permits',
        { query: '2298 Hazellynn Pl' },
        {
          json: PERMITS,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.query).toBe('2298 Hazellynn Pl');
      expect(result.result.structured.permits[0].caseNumber).toBe('BLD2020-00231');
      // value > 0 preserved; value <= 0 normalized to null
      expect(result.result.structured.permits[0].value).toBe(850_000);
      expect(result.result.structured.permits[1].value).toBeNull();
      expect(result.result.text).toContain('BLD2020-00231');
      expect(result.result.text).toContain('$850,000');
    });

    it('URL-encodes the query in the request path', async () => {
      let requested = '';
      await callTool(server, 'search_permits', { query: '2298 Hazellynn Pl' }, (url) => {
        requested = url;
        return { json: PERMITS };
      });
      expect(requested).toContain('/query/2298%20Hazellynn%20Pl');
    });

    it('treats a 404 as an empty result, not an error', async () => {
      const result = await callTool(
        server,
        'search_permits',
        { query: 'BLD9999' },
        { status: 404 },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.permits).toEqual([]);
      expect(result.result.text).toMatch(/no dnv permits/i);
    });

    it('maps a 429 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_permits',
        { query: 'anything' },
        { status: 429 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate-limit/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_permits',
        { query: 'anything' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/unavailable/i);
    });

    it('raises a retryable error on malformed JSON', async () => {
      const result = await callTool(
        server,
        'search_permits',
        { query: 'anything' },
        {
          text: 'not json at all',
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/malformed/i);
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_permits', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('suggest_addresses', () => {
    const ADDRESSES = ['2298 HAZELLYNN PL', '2300 HAZELLYNN PL', '2302 HAZELWOOD AVE'];

    it('returns address suggestions', async () => {
      const result = await callTool(
        server,
        'suggest_addresses',
        { prefix: 'hazel' },
        {
          json: ADDRESSES,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(3);
      expect(result.result.structured.prefix).toBe('hazel');
      expect(result.result.structured.addresses).toEqual(ADDRESSES);
      expect(result.result.text).toContain('2298 HAZELLYNN PL');
    });

    it('filters out blank entries returned by the API', async () => {
      const result = await callTool(
        server,
        'suggest_addresses',
        { prefix: 'hazel' },
        {
          json: ['2298 HAZELLYNN PL', '   ', '', 42],
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.addresses).toEqual(['2298 HAZELLYNN PL']);
    });

    it('reports an empty match list cleanly (404)', async () => {
      const result = await callTool(
        server,
        'suggest_addresses',
        { prefix: 'zzzzz' },
        { status: 404 },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no dnv addresses/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'suggest_addresses',
        { prefix: 'hazel' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty prefix before fetching', async () => {
      const result = await callTool(server, 'suggest_addresses', { prefix: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('recent_permits', () => {
    it('returns the recently-issued permits', async () => {
      const result = await callTool(server, 'recent_permits', {}, { json: PERMITS });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.permits[0].caseNumber).toBe('BLD2020-00231');
      expect(result.result.text).toContain('2298 HAZELLYNN PL');
    });

    it('hits the /last/ endpoint', async () => {
      let requested = '';
      await callTool(server, 'recent_permits', {}, (url) => {
        requested = url;
        return { json: PERMITS };
      });
      expect(requested).toContain('/last/');
    });

    it('reports an empty recent list cleanly (404)', async () => {
      const result = await callTool(server, 'recent_permits', {}, { status: 404 });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no recent dnv permits/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'recent_permits', {}, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });
  });
});
