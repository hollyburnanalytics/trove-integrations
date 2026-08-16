import { describe, expect, it } from 'vitest';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

/** A `/series/search` hit — CPIAUCSL and CPIAUCNS differ ONLY in seasonal adjustment. */
const CPI_SA = {
  id: 'CPIAUCSL',
  title: 'Consumer Price Index for All Urban Consumers: All Items in U.S. City Average',
  units: 'Index 1982-1984=100',
  frequency: 'Monthly',
  frequency_short: 'M',
  seasonal_adjustment: 'Seasonally Adjusted',
  seasonal_adjustment_short: 'SA',
  observation_start: '1947-01-01',
  observation_end: '2026-06-01',
  last_updated: '2026-07-15 07:41:03-05',
  popularity: 94,
};

const CPI_NSA = {
  ...CPI_SA,
  id: 'CPIAUCNS',
  seasonal_adjustment: 'Not Seasonally Adjusted',
  seasonal_adjustment_short: 'NSA',
  observation_start: '1913-01-01',
  popularity: 79,
};

const GDP_SAAR = {
  ...CPI_SA,
  id: 'GDP',
  title: 'Gross Domestic Product',
  units: 'Billions of Dollars',
  frequency: 'Quarterly',
  frequency_short: 'Q',
  seasonal_adjustment: 'Seasonally Adjusted Annual Rate',
  seasonal_adjustment_short: 'SAAR',
  popularity: 91,
};

const SEARCH_BODY = { count: 2, seriess: [CPI_SA, CPI_NSA] };

/** A `/series` metadata record for the id the observation tests use. */
const SERIES_META = {
  seriess: [
    {
      id: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      frequency_short: 'M',
      seasonal_adjustment_short: 'SA',
      observation_start: '1948-01-01',
      observation_end: '2026-06-01',
      last_updated: '2026-07-03 07:44:02-05',
      popularity: 96,
    },
  ],
};

const OBSERVATIONS_BODY = {
  count: 3,
  observations: [
    { date: '2026-05-01', value: '4.1' },
    { date: '2026-04-01', value: '4.0' },
    { date: '2026-03-01', value: '.' },
  ],
};

/**
 * Route the two upstream calls `get_observations` now makes (`/series` for
 * metadata, `/series/observations` for data) plus the SDK secret callback.
 */
function fredRoutes({ meta = SERIES_META, observations = OBSERVATIONS_BODY, onUrl } = {}) {
  return withSecret('test-key', (url) => {
    onUrl?.(url);
    if (url.includes('/series/observations')) {
      return typeof observations === 'function' ? observations(url) : { json: observations };
    }
    if (url.includes('/series/search')) return { json: SEARCH_BODY };
    return typeof meta === 'function' ? meta(url) : { json: meta };
  });
}

/** Build an observations body of `returned` rows out of a range of `total`. */
function pageOf(returned, total, startYear = 1985) {
  return {
    count: total,
    observations: Array.from({ length: returned }, (_, index) => ({
      date: `${startYear + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`,
      value: String(76 + index / 10),
    })),
  };
}

/**
 * Serve a synthetic `total`-point monthly series in pages, honouring the
 * `offset`/`limit` the server actually sends.
 *
 * When `aggregated`, it reproduces FRED's measured misbehaviour: `count` is the
 * true total only if the whole set fit strictly inside the requested limit, and
 * otherwise reports a bogus pre-aggregation number. Following the cursor must
 * still reassemble the series exactly.
 */
function pagedSeries(total, { aggregated = false, preAggregationCount = 99_999 } = {}) {
  const all = Array.from({ length: total }, (_, index) => ({
    date: `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`,
    value: String(index),
  }));
  return (url) => {
    const parameters = new URL(url).searchParams;
    const offset = Number(parameters.get('offset') ?? 0);
    const limit = Number(parameters.get('limit') ?? 24);
    const slice = all.slice(offset, offset + limit);
    const fits = slice.length < limit;
    return {
      json: {
        count: aggregated && !fits ? preAggregationCount : total,
        observations: slice,
      },
    };
  };
}

describe('fred MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((tool) => tool.name).toSorted()).toEqual([
      'get_observations',
      'search_series',
    ]);
  });

  describe('search_series', () => {
    it('distinguishes the SA/NSA pair that shares a title, units and frequency', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'consumer price index' },
        fredRoutes(),
      );
      expect(result.ok).toBe(true);
      const [first, second] = result.result.structured.series;
      expect(first.id).toBe('CPIAUCSL');
      expect(first.seasonalAdjustment).toBe('SA');
      expect(second.id).toBe('CPIAUCNS');
      expect(second.seasonalAdjustment).toBe('NSA');
      // The prose is what gets skimmed, so the distinction has to survive there.
      expect(result.result.text).toContain('seasonally adjusted');
      expect(result.result.text).toContain('not seasonally adjusted');
    });

    it('carries popularity and coverage so a caller can judge the ranking', async () => {
      const result = await callTool(server, 'search_series', { text: 'cpi' }, fredRoutes());
      const [first] = result.result.structured.series;
      expect(first.popularity).toBe(94);
      expect(first.observationStart).toBe('1947-01-01');
      expect(first.lastUpdated).toBe('2026-07-15 07:41:03-05');
      expect(result.result.structured.totalMatches).toBe(2);
    });

    it('forwards a non-default orderBy and omits the FRED default', async () => {
      let byPopularity = '';
      await callTool(
        server,
        'search_series',
        { text: 'inflation', orderBy: 'popularity' },
        withSecret('k', (url) => {
          if (url.includes('/series/search')) byPopularity = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(byPopularity).toContain('order_by=popularity');

      let byDefault = '';
      await callTool(
        server,
        'search_series',
        { text: 'inflation' },
        withSecret('k', (url) => {
          if (url.includes('/series/search')) byDefault = url;
          return { json: SEARCH_BODY };
        }),
      );
      expect(byDefault).not.toContain('order_by=');
    });

    it('filters to seasonally adjusted, counting SAAR as adjusted', async () => {
      const body = { count: 3, seriess: [CPI_SA, CPI_NSA, GDP_SAAR] };
      const result = await callTool(
        server,
        'search_series',
        { text: 'cpi', seasonalAdjustment: 'SA' },
        withSecret('k', { json: body }),
      );
      expect(result.result.structured.series.map((hit) => hit.id)).toEqual(['CPIAUCSL', 'GDP']);
    });

    it('filters to not-seasonally-adjusted', async () => {
      const body = { count: 3, seriess: [CPI_SA, CPI_NSA, GDP_SAAR] };
      const result = await callTool(
        server,
        'search_series',
        { text: 'cpi', seasonalAdjustment: 'NSA' },
        withSecret('k', { json: body }),
      );
      expect(result.result.structured.series.map((hit) => hit.id)).toEqual(['CPIAUCNS']);
    });

    it('filters by native frequency', async () => {
      const body = { count: 3, seriess: [CPI_SA, CPI_NSA, GDP_SAAR] };
      const result = await callTool(
        server,
        'search_series',
        { text: 'cpi', frequency: 'Q' },
        withSecret('k', { json: body }),
      );
      expect(result.result.structured.series.map((hit) => hit.id)).toEqual(['GDP']);
    });

    it('never passes off the unfiltered total as the filtered one', async () => {
      const mixed = Array.from({ length: 40 }, (_, index) => ({
        ...CPI_SA,
        id: `S${index}`,
        seasonal_adjustment_short: index < 3 ? 'NSA' : 'SA',
      }));
      const result = await callTool(
        server,
        'search_series',
        { text: 'cpi', seasonalAdjustment: 'NSA', limit: 10 },
        withSecret('k', { json: { count: 1959, seriess: mixed } }),
      );
      const structured = result.result.structured;
      expect(structured.count).toBe(3);
      // 1959 is FRED's count for the TEXT; it says nothing about the NSA subset.
      expect(structured.totalMatches).toBeNull();
      expect(structured.textMatches).toBe(1959);
      expect(structured.scanned).toBe(40);
      expect(result.result.text).toContain('filtered from 40 scanned of 1959 text matches');
      expect(result.result.text).not.toContain('3 of 1959');
    });

    it('blames the filter, not the query, when filters empty a real match', async () => {
      const calls = [];
      const result = await callTool(
        server,
        'search_series',
        // Deliberately carries stopwords ("what is the"), so that gating the
        // retry on scanned-vs-hits is actually exercised: gate it on hits and
        // this query WOULD be rewritten and re-sent. A stopword-free query
        // can't tell the two conditions apart.
        { text: 'what is the unemployment rate', frequency: 'BW' },
        withSecret('k', (url) => {
          if (!url.includes('/internal/secret')) calls.push(url);
          return { json: { count: 500, seriess: [CPI_SA] } };
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toContain('frequency=BW');
      expect(result.result.text).not.toMatch(/keyword-based/);
      // No stopword retry: the query was never the problem.
      expect(calls).toHaveLength(1);
      expect(result.result.structured.retriedAs).toBeNull();
    });

    it('reports the retry in structured output even when it also failed', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'how much do zzz cost' },
        withSecret('k', { json: { count: 0, seriess: [] } }),
      );
      expect(result.result.structured.retriedAs).toBe('zzz cost');
      expect(result.result.text).toContain('also tried "zzz cost"');
    });

    it('retries a natural-language question with the stopwords stripped', async () => {
      const seen = [];
      const result = await callTool(
        server,
        'search_series',
        { text: 'how much do houses cost' },
        withSecret('k', (url) => {
          if (!url.includes('/internal/secret')) seen.push(url);
          return url.includes('search_text=houses+cost')
            ? { json: { count: 1, seriess: [CPI_SA] } }
            : { json: { count: 0, seriess: [] } };
        }),
      );
      expect(seen).toHaveLength(2);
      expect(result.result.structured.retriedAs).toBe('houses cost');
      expect(result.result.text).toContain('matched on "houses cost"');
    });

    it('names the likely cause when even the retry finds nothing', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'how much do zzz cost' },
        withSecret('k', { json: { count: 0, seriess: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/keyword-based, not natural language/i);
      expect(result.result.text).toContain('zzz cost');
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

    it('maps a 400 to a non-retryable tool error surfacing FRED message', async () => {
      const result = await callTool(
        server,
        'search_series',
        { text: 'unemployment' },
        withSecret('test-key', { status: 400, json: { error_message: 'Bad search text.' } }),
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
        { series_ids: ['UNRATE'] },
        fredRoutes(),
      );
      expect(result.ok).toBe(true);
      const [block] = result.result.structured.series;
      expect(block.id).toBe('UNRATE');
      expect(block.returned).toBe(3);
      expect(block.observations[0]).toEqual({ date: '2026-05-01', value: 4.1 });
      expect(block.observations[2].value).toBeNull();
      expect(result.result.text).toContain('n/a');
    });

    it('reports a clipped range as truncated, with the total and a next offset', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], start: '1985-01-01', limit: 100, sort: 'asc' },
        fredRoutes({ observations: pageOf(100, 498) }),
      );
      const [block] = result.result.structured.series;
      expect(block.returned).toBe(100);
      expect(block.availableInRange).toBe(498);
      expect(block.truncated).toBe(true);
      expect(block.nextOffset).toBe(100);
      // The text mirror must say so too — some hosts show only the prose.
      expect(result.result.text).toContain('TRUNCATED');
      expect(result.result.text).toContain('398 more not returned');
    });

    it('does not flag a complete range as truncated', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], limit: 100 },
        fredRoutes({ observations: pageOf(24, 24) }),
      );
      const [block] = result.result.structured.series;
      expect(block.truncated).toBe(false);
      expect(block.nextOffset).toBeNull();
      expect(result.result.text).toContain('complete');
      expect(result.result.text).not.toContain('TRUNCATED');
    });

    it('never advertises a next offset when the page came back empty', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], offset: 900 },
        fredRoutes({ observations: { count: 498, observations: [] } }),
      );
      expect(result.result.structured.series[0].nextOffset).toBeNull();
    });

    it('labels the numbers with title, units and seasonal adjustment', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'] },
        fredRoutes(),
      );
      const [block] = result.result.structured.series;
      expect(block.title).toBe('Unemployment Rate');
      expect(block.units).toBe('Percent');
      expect(block.seasonalAdjustment).toBe('SA');
      expect(block.coverageStart).toBe('1948-01-01');
      expect(result.result.text).toContain('Unemployment Rate');
      expect(result.result.text).toContain('Percent');
    });

    it('forwards units, frequency, aggregation, offset, sort and date bounds', async () => {
      let requested = '';
      await callTool(
        server,
        'get_observations',
        {
          series_ids: ['UNRATE'],
          start: '2020-01-01',
          end: '2021-01-01',
          units: 'pc1',
          frequency: 'a',
          aggregation_method: 'eop',
          limit: 50,
          offset: 10,
          sort: 'asc',
        },
        fredRoutes({
          onUrl: (url) => {
            if (url.includes('/series/observations')) requested = url;
          },
        }),
      );
      expect(requested).toContain('series_id=UNRATE');
      expect(requested).toContain('units=pc1');
      expect(requested).toContain('frequency=a');
      expect(requested).toContain('aggregation_method=eop');
      expect(requested).toContain('offset=10');
      expect(requested).toContain('sort_order=asc');
      // limit+1 because this call aggregates — see the `count` tests above.
      expect(requested).toContain('limit=51');
      expect(requested).toContain('observation_start=2020-01-01');
      expect(requested).toContain('observation_end=2021-01-01');
    });

    it('omits frequency and aggregation when no frequency was asked for', async () => {
      let requested = '';
      await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'] },
        fredRoutes({
          onUrl: (url) => {
            if (url.includes('/series/observations')) requested = url;
          },
        }),
      );
      expect(requested).not.toContain('frequency=');
      expect(requested).not.toContain('aggregation_method=');
      expect(requested).toContain('units=lin');
    });

    it('rejects upsampling by name instead of forwarding a doomed request', async () => {
      let fetchedObservations = false;
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], frequency: 'd' },
        fredRoutes({
          onUrl: (url) => {
            if (url.includes('/series/observations')) fetchedObservations = true;
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('monthly');
      expect(result.error).toContain('daily');
      expect(fetchedObservations).toBe(false);
    });

    // Measured against the live API: with `frequency` set, FRED reports the
    // UN-aggregated row count unless the whole aggregated set fits strictly
    // inside `limit`. 5y of daily DGS10 asked for monthly answers count=1305
    // (not 60) at limit=10 AND at limit=60, and only answers 60 at limit=61.
    // So `count` is wrong exactly when the answer is truncated. These three
    // tests pin that we never repeat it back as `availableInRange`.
    it('ignores FRED count when aggregating and the page is full', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['DGS10'], frequency: 'm', limit: 10, sort: 'asc' },
        fredRoutes({
          meta: { seriess: [{ ...SERIES_META.seriess[0], id: 'DGS10', frequency_short: 'D' }] },
          // 11 rows come back because the server asked for limit+1.
          observations: pageOf(11, 1305),
        }),
      );
      const [block] = result.result.structured.series;
      expect(block.returned).toBe(10);
      expect(block.availableInRange).toBeNull();
      expect(block.truncated).toBe(true);
      expect(block.nextOffset).toBe(10);
      expect(result.result.text).not.toContain('1305');
      expect(result.result.text).toContain('not reported by FRED');
    });

    it('requests one extra row so a full aggregated page is detectable', async () => {
      let requested = '';
      await callTool(
        server,
        'get_observations',
        { series_ids: ['DGS10'], frequency: 'm', limit: 60 },
        fredRoutes({
          meta: { seriess: [{ ...SERIES_META.seriess[0], id: 'DGS10', frequency_short: 'D' }] },
          onUrl: (url) => {
            if (url.includes('/series/observations')) requested = url;
          },
        }),
      );
      expect(requested).toContain('limit=61');
    });

    it('calls an aggregated page complete when the extra row does not come back', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['DGS10'], frequency: 'm', limit: 60, sort: 'asc' },
        fredRoutes({
          meta: { seriess: [{ ...SERIES_META.seriess[0], id: 'DGS10', frequency_short: 'D' }] },
          // Exactly the aggregated size — the boundary where FRED still says 1305.
          observations: pageOf(60, 1305),
        }),
      );
      const [block] = result.result.structured.series;
      expect(block.returned).toBe(60);
      expect(block.availableInRange).toBe(60);
      expect(block.truncated).toBe(false);
      expect(block.nextOffset).toBeNull();
      expect(result.result.text).toContain('complete');
    });

    it('allows downsampling to a coarser frequency', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], frequency: 'a' },
        fredRoutes(),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.series[0].frequency).toBe('a (avg)');
    });

    it('returns parallel dates/values arrays in columnar format', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], format: 'columnar' },
        fredRoutes(),
      );
      const [block] = result.result.structured.series;
      expect(block.observations).toBeUndefined();
      expect(block.dates).toEqual(['2026-05-01', '2026-04-01', '2026-03-01']);
      expect(block.values).toHaveLength(3);
      expect(block.values.slice(0, 2)).toEqual([4.1, 4]);
      expect(block.values[2]).toBeNull();
    });

    it('fetches several series in one call', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['CPIAUCSL', 'DGS10'] },
        fredRoutes(),
      );
      expect(result.result.structured.seriesCount).toBe(2);
      expect(result.result.structured.series.map((block) => block.id)).toEqual([
        'CPIAUCSL',
        'DGS10',
      ]);
    });

    it('de-duplicates repeated ids', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE', 'UNRATE'] },
        fredRoutes(),
      );
      expect(result.result.structured.seriesCount).toBe(1);
    });

    it('refuses an oversized pull rather than silently shrinking it', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['A', 'B', 'C'], limit: 1000 },
        fredRoutes(),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('2000-point');
    });

    it('states the series coverage when the requested range is empty', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'], start: '2030-01-01', end: '2031-01-01' },
        fredRoutes({ observations: { count: 0, observations: [] } }),
      );
      expect(result.ok).toBe(true);
      const [block] = result.result.structured.series;
      expect(block.returned).toBe(0);
      expect(block.note).toContain('1948-01-01');
      expect(block.note).toContain('2026-06-01');
      expect(result.result.text).toContain('covers 1948-01-01 to 2026-06-01');
    });

    it('still returns data when the metadata lookup fails', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'] },
        fredRoutes({ meta: () => ({ status: 500, text: 'boom' }) }),
      );
      expect(result.ok).toBe(true);
      const [block] = result.result.structured.series;
      expect(block.title).toBeNull();
      expect(block.returned).toBe(3);
    });

    it('maps a 500 on the data call to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE'] },
        fredRoutes({ observations: () => ({ status: 500, text: 'upstream boom' }) }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['BOGUS'] },
        fredRoutes({
          meta: { seriess: [] },
          observations: () => ({ status: 400, json: { error_message: 'Bad series id.' } }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('Bad series id.');
    });

    it('keeps the good series when one id in the batch fails', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['UNRATE', 'BOGUSID'], limit: 3 },
        fredRoutes({
          observations: (url) =>
            url.includes('BOGUSID')
              ? { status: 400, json: { error_message: 'The series does not exist.' } }
              : { json: OBSERVATIONS_BODY },
        }),
      );
      expect(result.ok).toBe(true);
      const [good, bad] = result.result.structured.series;
      expect(good.returned).toBe(3);
      expect(good.error).toBeNull();
      expect(bad.id).toBe('BOGUSID');
      expect(bad.error).toContain('does not exist');
      expect(result.result.text).toContain('FAILED');
    });

    it('still throws when every series in the batch fails', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['NOPE1', 'NOPE2'] },
        fredRoutes({
          meta: { seriess: [] },
          observations: () => ({ status: 400, json: { error_message: 'No such series.' } }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
    });

    it('keeps the native frequency visible when aggregating', async () => {
      const result = await callTool(
        server,
        'get_observations',
        { series_ids: ['DGS10'], frequency: 'a' },
        fredRoutes({
          meta: {
            seriess: [
              { ...SERIES_META.seriess[0], id: 'DGS10', frequency: 'Daily', frequency_short: 'D' },
            ],
          },
        }),
      );
      const [block] = result.result.structured.series;
      expect(block.frequency).toBe('a (avg)');
      expect(block.nativeFrequency).toBe('Daily');
    });

    // The truncation metadata makes a promise: follow nextOffset and you get
    // the whole series. These assert the promise end to end, since a cursor
    // that overlaps, gaps, or never terminates is its own silent-wrong answer.
    it('reassembles the whole series by following nextOffset', async () => {
      const dates = [];
      let offset = 0;
      let declaredTotal;
      let pages = 0;
      for (;;) {
        const result = await callTool(
          server,
          'get_observations',
          { series_ids: ['UNRATE'], limit: 100, offset, sort: 'asc' },
          fredRoutes({ observations: pagedSeries(498) }),
        );
        expect(result.ok).toBe(true);
        const block = result.result.structured.series[0];
        declaredTotal ??= block.availableInRange;
        dates.push(...block.observations.map((o) => o.date));
        pages += 1;
        if (!block.truncated || !Number.isInteger(block.nextOffset)) break;
        offset = block.nextOffset;
        expect(pages).toBeLessThan(20);
      }
      expect(declaredTotal).toBe(498);
      expect(dates).toHaveLength(498);
      expect(new Set(dates).size).toBe(498);
      expect(dates.every((d, index) => index === 0 || d > dates[index - 1])).toBe(true);
      expect(pages).toBe(5);
    });

    it('reassembles an aggregated series despite FRED misreporting count', async () => {
      const dates = [];
      let offset = 0;
      let pages = 0;
      for (;;) {
        const result = await callTool(
          server,
          'get_observations',
          { series_ids: ['UNRATE'], frequency: 'q', limit: 25, offset, sort: 'asc' },
          fredRoutes({ observations: pagedSeries(60, { aggregated: true }) }),
        );
        const block = result.result.structured.series[0];
        // The bogus pre-aggregation count must never reach the caller.
        expect(block.availableInRange).not.toBe(99_999);
        dates.push(...block.observations.map((o) => o.date));
        pages += 1;
        if (!block.truncated || !Number.isInteger(block.nextOffset)) break;
        offset = block.nextOffset;
        expect(pages).toBeLessThan(10);
      }
      expect(dates).toHaveLength(60);
      expect(new Set(dates).size).toBe(60);
      expect(pages).toBe(3);
    });

    it('rejects a malformed start date before fetching', async () => {
      const result = await callTool(server, 'get_observations', {
        series_ids: ['UNRATE'],
        start: '2020/01/01',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty series list', async () => {
      const result = await callTool(server, 'get_observations', { series_ids: [] });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects more than five series', async () => {
      const result = await callTool(server, 'get_observations', {
        series_ids: ['A', 'B', 'C', 'D', 'E', 'F'],
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
