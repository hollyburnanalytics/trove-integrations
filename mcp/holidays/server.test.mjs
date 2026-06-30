import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const HOLIDAYS = [
  {
    date: '2026-01-01',
    name: "New Year's Day",
    localName: "New Year's Day",
    global: true,
    types: ['Public'],
  },
  {
    date: '2026-07-01',
    name: 'Canada Day',
    localName: 'Canada Day',
    global: true,
    types: ['Public'],
  },
];

describe('holidays MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'next_holidays',
      'public_holidays',
    ]);
  });

  describe('public_holidays', () => {
    it('returns holidays for a country and year', async () => {
      const result = await callTool(
        server,
        'public_holidays',
        { year: 2026, country: 'CA' },
        {
          json: HOLIDAYS,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.country).toBe('CA');
      expect(result.result.text).toContain('Canada Day');
    });

    it('uppercases the country code in the request path', async () => {
      let requested = '';
      await callTool(server, 'public_holidays', { year: 2026, country: 'ca' }, (url) => {
        requested = url;
        return { json: HOLIDAYS };
      });
      expect(requested).toContain('/PublicHolidays/2026/CA');
    });

    it('maps a 404 to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'public_holidays',
        { year: 2026, country: 'ZZ' },
        {
          status: 404,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/country code/i);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'public_holidays',
        { year: 2026, country: 'CA' },
        {
          status: 500,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('rejects invalid arguments before fetching', async () => {
      const result = await callTool(server, 'public_holidays', { year: 2026, country: 'CANADA' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('next_holidays', () => {
    it('returns the upcoming holidays', async () => {
      const result = await callTool(server, 'next_holidays', { country: 'US' }, { json: HOLIDAYS });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
    });

    it('reports an empty upcoming list cleanly', async () => {
      const result = await callTool(server, 'next_holidays', { country: 'US' }, { json: [] });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no holidays/i);
    });
  });
});
