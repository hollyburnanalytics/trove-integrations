import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// A realistic `[metadata, rows]` tuple from the World Bank /indicator endpoint.
const INDICATOR_LIST = [
  { page: 1, pages: 1, per_page: 2000, total: 3 },
  [
    {
      id: 'NY.GDP.MKTP.CD',
      name: 'GDP (current US$)',
      sourceNote:
        'GDP at purchaser prices is the sum of gross value added by all resident producers.',
    },
    {
      id: 'SP.POP.TOTL',
      name: 'Population, total',
      sourceNote: 'Total population is based on the de facto definition of population.',
    },
    {
      id: 'SP.DYN.LE00.IN',
      name: 'Life expectancy at birth, total (years)',
      sourceNote: '',
    },
  ],
];

// A realistic `[metadata, rows]` tuple from the /country/{c}/indicator/{i}
// endpoint. Defined as a raw JSON string (served via `{ text }`) so the final
// row's `value` stays on the wire as a real JSON `null` — exercising the
// missing-value path. `JSON.stringify` of a JS object would drop an `undefined`
// key, changing the wire shape under test.
const SERIES = `[
  { "page": 1, "pages": 1, "per_page": 120, "total": 3 },
  [
    {
      "indicator": { "id": "NY.GDP.MKTP.CD", "value": "GDP (current US$)" },
      "country": { "id": "CA", "value": "Canada" },
      "date": "2022",
      "value": 2161483181167.62
    },
    {
      "indicator": { "id": "NY.GDP.MKTP.CD", "value": "GDP (current US$)" },
      "country": { "id": "CA", "value": "Canada" },
      "date": "2021",
      "value": 2007471324235.69
    },
    {
      "indicator": { "id": "NY.GDP.MKTP.CD", "value": "GDP (current US$)" },
      "country": { "id": "CA", "value": "Canada" },
      "date": "2020",
      "value": null
    }
  ]
]`;

describe('world-bank MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_indicator',
      'search_indicators',
    ]);
  });

  describe('search_indicators', () => {
    it('finds matching indicators by keyword', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'population' },
        { json: INDICATOR_LIST },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.query).toBe('population');
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.indicators[0].id).toBe('SP.POP.TOTL');
      expect(result.result.structured.indicators[0].name).toBe('Population, total');
      expect(result.result.structured.indicators[0].note).toContain('de facto');
      expect(result.result.text).toContain('SP.POP.TOTL');
    });

    it('matches against the indicator code as well as the name', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'NY.GDP' },
        { json: INDICATOR_LIST },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.indicators[0].id).toBe('NY.GDP.MKTP.CD');
    });

    it('reports a null note when sourceNote is empty', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'life expectancy' },
        { json: INDICATOR_LIST },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.indicators[0].note).toBeNull();
    });

    it('honors the limit', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'p', limit: 1 },
        { json: INDICATOR_LIST },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.indicators).toHaveLength(1);
    });

    it('returns a clean empty result when nothing matches', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'zzzznomatch' },
        { json: INDICATOR_LIST },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.indicators).toHaveLength(0);
      expect(result.result.text).toMatch(/no world bank indicators/i);
    });

    it('queries the WDI source endpoint', async () => {
      let requested = '';
      await callTool(server, 'search_indicators', { query: 'gdp' }, (url) => {
        requested = url;
        return { json: INDICATOR_LIST };
      });
      expect(requested).toContain('/indicator?');
      expect(requested).toContain('source=2');
    });

    it('maps a 503 to a retryable tool error', async () => {
      const result = await callTool(server, 'search_indicators', { query: 'gdp' }, { status: 503 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/temporarily unavailable/i);
    });

    it('maps a 429 to a retryable tool error', async () => {
      const result = await callTool(server, 'search_indicators', { query: 'gdp' }, { status: 429 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(server, 'search_indicators', { query: 'gdp' }, { status: 400 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/rejected the request/i);
    });

    it('surfaces an HTTP-200 World Bank error body as a non-retryable error', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'gdp' },
        {
          json: [{ message: [{ value: 'The provided parameter value is not valid' }] }],
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('The provided parameter value is not valid');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_indicators', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a limit above 25 before fetching', async () => {
      const result = await callTool(server, 'search_indicators', { query: 'gdp', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_indicator', () => {
    it('returns a country time-series, newest first', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { text: SERIES },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.country).toBe('CA');
      expect(result.result.structured.indicator).toBe('NY.GDP.MKTP.CD');
      expect(result.result.structured.indicatorName).toBe('GDP (current US$)');
      expect(result.result.structured.count).toBe(3);
      expect(result.result.structured.observations[0]).toEqual({
        year: '2022',
        value: 2_161_483_181_167.62,
      });
      expect(result.result.structured.observations[2].value).toBeNull();
      expect(result.result.text).toContain('GDP (current US$)');
      expect(result.result.text).toContain('2022');
    });

    it('builds a date range when both start and end are given', async () => {
      let requested = '';
      await callTool(
        server,
        'get_indicator',
        { country: 'USA', indicator: 'SP.POP.TOTL', start: 2010, end: 2020 },
        (url) => {
          requested = url;
          return { text: SERIES };
        },
      );
      expect(requested).toContain('/country/USA/indicator/SP.POP.TOTL');
      expect(requested).toContain('date=2010%3A2020');
    });

    it('omits the date range when only one bound is given', async () => {
      let requested = '';
      await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'SP.POP.TOTL', start: 2010 },
        (url) => {
          requested = url;
          return { text: SERIES };
        },
      );
      expect(requested).not.toContain('date=');
    });

    it('returns a clean empty result when there are no observations', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { json: [{ page: 1, total: 0 }, []] },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.observations).toHaveLength(0);
      expect(result.result.structured.indicatorName).toBeNull();
      expect(result.result.text).toMatch(/no world bank data/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/check the country and indicator codes/i);
    });

    it('rejects a one-character country code before fetching', async () => {
      const result = await callTool(server, 'get_indicator', {
        country: 'C',
        indicator: 'SP.POP.TOTL',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty indicator code before fetching', async () => {
      const result = await callTool(server, 'get_indicator', { country: 'CA', indicator: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
