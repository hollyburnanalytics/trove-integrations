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
    it('reports how many matched, not just how many were returned', async () => {
      const many = [
        { page: 1, pages: 1, per_page: 2000, total: 5 },
        Array.from({ length: 5 }, (_, index) => ({
          id: `SP.POP.${index}`,
          name: `Population measure ${index}`,
          sourceNote: '',
        })),
      ];
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'population', limit: 2 },
        { json: many },
      );
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.totalMatches).toBe(5);
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.text).toContain('2 of 5 indicator(s)');
    });

    it('says so when the catalogue page did not hold the whole catalogue', async () => {
      // Matching is client-side over one fetched page. If the WDI catalogue
      // ever outgrows it, the search quietly loses its tail — so say it.
      const oversized = [
        { page: 1, pages: 2, per_page: 2000, total: 2500 },
        [{ id: 'SP.POP.TOTL', name: 'Population, total', sourceNote: '' }],
      ];
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'population' },
        { json: oversized },
      );
      expect(result.result.text).toContain('searched 1 of 2500 WDI indicators');
    });

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

    // The API rejects an open-ended `date=2010:`, so a one-sided range is
    // filled with a sentinel. It must never be dropped: silently ignoring a
    // bound the caller supplied returns the wrong years under the right label.
    it('honours a start-only range', async () => {
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
      expect(requested).toContain('date=2010%3A2100');
    });

    it('honours an end-only range', async () => {
      let requested = '';
      await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'SP.POP.TOTL', end: 1970 },
        (url) => {
          requested = url;
          return { text: SERIES };
        },
      );
      expect(requested).toContain('date=1800%3A1970');
    });

    it('sends no date filter when neither bound is given', async () => {
      let requested = '';
      await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'SP.POP.TOTL' },
        (url) => {
          requested = url;
          return { text: SERIES };
        },
      );
      expect(requested).not.toContain('date=');
    });

    it('rejects a reversed range by name', async () => {
      const result = await callTool(server, 'get_indicator', {
        country: 'CA',
        indicator: 'SP.POP.TOTL',
        start: 2020,
        end: 2010,
      });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('after end');
    });

    it('reports a clipped page against the API total, not just the page', async () => {
      // `country: "all"` for one indicator is ~17,500 rows; a 120-row page is
      // ~2 of 265 entities. Reporting only the page called that the answer.
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'all', indicator: 'NY.GDP.MKTP.CD' },
        { json: [{ page: 1, pages: 146, per_page: 120, total: 17_490 }, JSON.parse(SERIES)[1]] },
      );
      expect(result.ok).toBe(true);
      const { structured } = result.result;
      expect(structured.count).toBe(3);
      expect(structured.total).toBe(17_490);
      expect(structured.truncated).toBe(true);
      expect(structured.nextPage).toBe(2);
      expect(result.result.text).toContain('of 17490');
      expect(result.result.text).toContain('TRUNCATED');
    });

    it('derives truncation from rows consumed, not a trusted `pages` field', async () => {
      // `pages` absent/stale must not let a partial result claim completeness.
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'all', indicator: 'NY.GDP.MKTP.CD' },
        { json: [{ page: 1, total: 17_490 }, JSON.parse(SERIES)[1]] },
      );
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.structured.nextPage).toBe(2);
    });

    it('marks a multi-entity count as page-scoped when more remains', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'all', indicator: 'NY.GDP.MKTP.CD' },
        {
          json: [
            { page: 1, pages: 146, total: 17_490 },
            [
              { country: { id: 'CA', value: 'Canada' }, date: '2022', value: 1 },
              { country: { id: 'US', value: 'United States' }, date: '2022', value: 2 },
            ],
          ],
        },
      );
      expect(result.result.text).toContain('across 2 entities on this page');
    });

    it('does not flag a complete result as truncated', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { text: SERIES },
      );
      expect(result.result.structured.truncated).toBe(false);
      expect(result.result.structured.nextPage).toBeNull();
      expect(result.result.text).not.toContain('TRUNCATED');
    });

    it('forwards limit and page', async () => {
      let requested = '';
      await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'SP.POP.TOTL', limit: 500, page: 3 },
        (url) => {
          requested = url;
          return { text: SERIES };
        },
      );
      expect(requested).toContain('per_page=500');
      expect(requested).toContain('page=3');
    });

    it('labels each row with its country when the pull spans several', async () => {
      const multi = [
        { page: 1, pages: 1, total: 2 },
        [
          {
            indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' },
            country: { id: 'CA', value: 'Canada' },
            date: '2022',
            value: 1,
          },
          {
            indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' },
            country: { id: 'US', value: 'United States' },
            date: '2022',
            value: 2,
          },
        ],
      ];
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'all', indicator: 'NY.GDP.MKTP.CD' },
        { json: multi },
      );
      const [first, second] = result.result.structured.observations;
      expect(first.country).toBe('Canada');
      expect(second.country).toBe('United States');
      expect(result.result.structured.countries).toEqual(['Canada', 'United States']);
      expect(result.result.text).toContain('Canada, 2022');
    });

    it('omits the per-row country for a single-country pull', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { text: SERIES },
      );
      expect(result.result.structured.observations[0].country).toBeUndefined();
    });

    it('treats a non-JSON 200 as a transient upstream failure, not a bad request', async () => {
      // The API intermittently serves an HTML error page under a 200; reporting
      // that as "check the codes" sent callers to fix codes that were correct.
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { text: '<!DOCTYPE html><html><body>Runtime Error</body></html>' },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/non-json/i);
    });

    it('previews missing years as n/a rather than hiding them', async () => {
      const result = await callTool(
        server,
        'get_indicator',
        { country: 'CA', indicator: 'NY.GDP.MKTP.CD' },
        { text: SERIES },
      );
      expect(result.result.text).toContain('2020: n/a');
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
