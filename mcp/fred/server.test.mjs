import { describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

const SEARCH_BODY = {
  seriess: [
    {
      id: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      observation_start: '1948-01-01',
      observation_end: '2026-05-01',
    },
    {
      id: 'U6RATE',
      title: 'Total Unemployed (U-6)',
      units: 'Percent',
      frequency: 'Monthly',
      observation_start: '1994-01-01',
      observation_end: '2026-05-01',
    },
  ],
};

const OBSERVATIONS_BODY = {
  observations: [
    { date: '2026-05-01', value: '4.1' },
    { date: '2026-04-01', value: '4.0' },
    { date: '2026-03-01', value: '.' },
  ],
};

describe('fred MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_observations',
      'search_series',
    ]);
  });

  describe('search_series', () => {
    it('returns matching series with mapped fields', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'unemployment rate', limit: 10 },
        withSecret('test-key', { json: SEARCH_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.text).toBe('unemployment rate');
      const first = result.result.structured.series[0];
      expect(first.id).toBe('UNRATE');
      expect(first.title).toBe('Unemployment Rate');
      expect(first.units).toBe('Percent');
      expect(first.frequency).toBe('Monthly');
      expect(first.observationStart).toBe('1948-01-01');
      expect(first.observationEnd).toBe('2026-05-01');
      expect(result.result.text).toContain('UNRATE');
    });

    it('passes the api key and search params to FRED', async () => {
      let requested = '';
      await callTool(
        server,
        'search_series',
        { text: 'CPI', limit: 5 },
        withSecret('secret-abc', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(requested).toContain('/series/search');
      expect(requested).toContain('search_text=CPI');
      expect(requested).toContain('limit=5');
      expect(requested).toContain('api_key=secret-abc');
      expect(requested).toContain('file_type=json');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'zzzznotaseries' },
        withSecret('test-key', { json: { seriess: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no fred series/i);
    });

    it('maps a 400 to a non-retryable tool error surfacing FRED message', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'unemployment' },
        withSecret('test-key', {
          status: 400,
          json: { error_message: 'Bad search text.' },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('Bad search text.');
    });

    it('maps a 403 to a non-retryable key error', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'unemployment' },
        withSecret('test-key', { status: 403, json: { error_message: 'Bad key' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/api key/i);
    });

    it('rejects an empty text argument before fetching', async () => {
      const result = await callTool(server, 'search_series', { text: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_series', { text: 'cpi', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_observations', () => {
    it('returns observations with missing values parsed to null', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_id: 'UNRATE', limit: 24, sort: 'desc' },
        withSecret('test-key', { json: OBSERVATIONS_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.seriesId).toBe('UNRATE');
      expect(result.result.structured.count).toBe(3);
      const obs = result.result.structured.observations;
      expect(obs[0]).toEqual({ date: '2026-05-01', value: 4.1 });
      expect(obs[2].date).toBe('2026-03-01');
      expect(obs[2].value).toBeNull();
      expect(result.result.text).toContain('UNRATE');
      expect(result.result.text).toContain('n/a');
    });

    it('forwards series id, sort, limit and date bounds to FRED', async () => {
      let requested = '';
      await callTool(
        server,
        'get_observations',
        { series_id: 'CPIAUCSL', start: '2020-01-01', end: '2021-01-01', limit: 50, sort: 'asc' },
        withSecret('test-key', (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: OBSERVATIONS_BODY };
        }),
      );
      expect(requested).toContain('/series/observations');
      expect(requested).toContain('series_id=CPIAUCSL');
      expect(requested).toContain('sort_order=asc');
      expect(requested).toContain('limit=50');
      expect(requested).toContain('observation_start=2020-01-01');
      expect(requested).toContain('observation_end=2021-01-01');
    });

    it('reports an empty observation set cleanly', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_id: 'UNRATE' },
        withSecret('test-key', { json: { observations: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no observations/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_id: 'UNRATE' },
        withSecret('test-key', { status: 500, text: 'upstream boom' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_id: 'BOGUS' },
        withSecret('test-key', {
          status: 400,
          json: { error_message: 'Bad series id.' },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('Bad series id.');
    });

    it('rejects a malformed start date before fetching', async () => {
      const result = await callTool(server, 'get_observations', {
        series_id: 'UNRATE',
        start: '2020/01/01',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty series id before fetching', async () => {
      const result = await callTool(server, 'get_observations', { series_id: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
