import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import { parseChartCsv } from './csv.ts';
import server from './server.ts';

/**
 * Fixtures mirror real payloads captured from OWID's live endpoints.
 *
 * NOTE ON SLUGS: the server's egress client keeps an in-isolate response cache,
 * so two tests that fetch the SAME url would have the second served from cache
 * and never reach the mock. Every test below therefore uses its own slug/query.
 */

const CSV = [
  'entity,code,year,share_of_hens_cage_free',
  'Canada,CAN,2000,12.5',
  'Canada,CAN,2001,',
  'United States,USA,2000,3.25',
].join('\n');

const METADATA = {
  chart: {
    title: 'Share of egg-laying hens in cage-free systems',
    subtitle: 'Cage-free housing includes barns and free-range farms.',
    citation: 'European Commission (2026) and other sources',
    originalChartUrl: 'https://ourworldindata.org/grapher/eggs-cage-free',
  },
  columns: {
    'Share of egg-laying hens in cage-free systems': {
      titleShort: 'Share of hens in cage-free systems',
      shortName: 'share_of_hens_cage_free',
      unit: '%',
      shortUnit: '%',
      timespan: '1996-2025',
      lastUpdated: '2026-06-11',
      nextUpdate: '2027-06-11',
      owidVariableId: 1_269_958,
      descriptionShort: 'Cage-free housing includes barns and free-range farms.',
      descriptionProcessing: '- Data for the UK and US come from official statistics.',
      citationShort: 'European Commission (2026) – processed by Our World in Data',
      citationLong: 'European Commission (2026); Defra (2026) – processed by Our World in Data.',
      fullMetadata: 'https://api.ourworldindata.org/v1/indicators/1269958.metadata.json',
      type: 'float',
    },
  },
  dateDownloaded: '2026-07-26',
};

const INDICATOR = {
  id: 1_269_958,
  name: 'Share of egg-laying hens in cage-free systems',
  unit: '%',
  nonRedistributable: false,
  origins: [
    {
      producer: 'European Commission',
      citationFull: 'European Commission - Laying hens by way of keeping (2026).',
      urlMain: 'https://agriculture.ec.europa.eu/farming/animal-products/eggs_en',
      dateAccessed: '2026-06-11',
      license: { name: 'CC BY 4.0', url: 'https://commission.europa.eu/legal-notice_en' },
    },
    {
      producer: 'Defra',
      citationFull: 'Quarterly UK statistics on Egg Packing Station Throughput and Prices.',
      urlMain: 'https://www.gov.uk/government/statistics/egg-statistics',
      dateAccessed: '2026-04-16',
      license: {
        name: 'OGL v3.0',
        url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
      },
    },
  ],
  dimensions: {
    entities: {
      values: [
        { id: 33, name: 'Canada', code: 'CAN' },
        { id: 1, name: 'United States', code: 'USA' },
        { id: 9, name: 'United Kingdom', code: 'GBR' },
      ],
    },
  },
};

const CHART_SEARCH = {
  query: 'hens',
  nbHits: 42,
  page: 0,
  nbPages: 21,
  hitsPerPage: 2,
  results: [
    {
      title: 'Share of egg-laying hens in cage-free systems',
      slug: 'eggs-cage-free',
      subtitle: 'Cage-free housing includes barns and free-range farms.',
      variantName: '',
      type: 'chart',
      availableEntities: ['Canada', 'United States', 'United Kingdom'],
      availableTabs: ['Table', 'LineChart'],
      publishedAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      url: 'https://ourworldindata.org/grapher/eggs-cage-free',
    },
  ],
};

const INDICATOR_SEARCH = {
  query: 'free range eggs',
  total_results: 1,
  results: [
    {
      title: 'Number of eggs from hens in non-organic, free-range farms',
      indicator_id: 1_269_972,
      snippet: '',
      description: '',
      score: 0.852_968_811_988_830_6,
      popularity: 0.568_736,
      n_charts: 1,
      catalog_path: 'grapher/animal_welfare/2026-06-11/eggs/eggs#n_eggs_free_range',
      metadata: { chart_count: 1, unit: 'eggs' },
    },
  ],
};

/**
 * Chart metadata pointing at a specific indicator id.
 *
 * Cache isolation, not decoration: the egress cache is keyed by URL and lives
 * for the whole test file, so a test that needs its own indicator fixture must
 * also give it its own indicator id.
 */
function metadataForIndicator(indicatorId) {
  const [title, column] = Object.entries(METADATA.columns)[0];
  return {
    ...METADATA,
    columns: {
      [title]: {
        ...column,
        owidVariableId: indicatorId,
        fullMetadata: `https://api.ourworldindata.org/v1/indicators/${indicatorId}.metadata.json`,
      },
    },
  };
}

/** Serve the standard chart trio (csv + chart metadata + indicator metadata). */
function chartResponder(overrides = {}) {
  return (url) => {
    if (url.includes('/api/search')) return { json: CHART_SEARCH };
    if (url.includes('search.owid.io')) return { json: INDICATOR_SEARCH };
    if (url.includes('api.ourworldindata.org')) {
      return overrides.indicator ?? { json: INDICATOR };
    }
    if (url.includes('.metadata.json')) return overrides.metadata ?? { json: METADATA };
    if (url.includes('.csv')) {
      return overrides.csv ?? { text: CSV, headers: { 'content-type': 'text/csv' } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe('our-world-in-data MCP server', () => {
  it('lists the four read-only tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_chart_data',
      'get_chart_metadata',
      'search_charts',
      'search_indicators',
    ]);
    expect(server.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('search_charts', () => {
    it('returns slugs and replaces the entity list with a count', async () => {
      const result = await callTool(server, 'search_charts', { query: 'hens' }, chartResponder());
      expect(result.ok).toBe(true);
      const { structured, text } = result.result;
      expect(structured.totalHits).toBe(42);
      expect(structured.charts[0].slug).toBe('eggs-cage-free');
      expect(structured.charts[0].entityCount).toBe(3);
      expect(structured.charts[0].variantName).toBeNull();
      // The 265-name entity array must never reach the model.
      expect(JSON.stringify(structured)).not.toContain('availableEntities');
      expect(text).toContain('eggs-cage-free');
    });

    it('passes country filters through to the search API', async () => {
      let seen = '';
      await callTool(
        server,
        'search_charts',
        { query: 'hens-filtered', countries: ['Canada', 'Japan'], require_all_countries: true },
        (url) => {
          if (url.includes('/api/search')) {
            seen = url;
            return { json: CHART_SEARCH };
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
      );
      expect(decodeURIComponent(seen)).toContain('countries=Canada~Japan');
      expect(seen).toContain('requireAllCountries=true');
    });

    it('reports an empty search cleanly', async () => {
      const result = await callTool(
        server,
        'search_charts',
        { query: 'zzz-nothing' },
        {
          json: { query: 'zzz', nbHits: 0, results: [] },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no our world in data charts/i);
    });
  });

  describe('upstream failure handling', () => {
    it('reports a rejected chart search as non-retryable', async () => {
      const result = await callTool(
        server,
        'search_charts',
        { query: 'bad-search' },
        {
          status: 400,
          json: { error: 'bad' },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
    });

    it('treats a malformed search body as retryable rather than empty', async () => {
      const result = await callTool(
        server,
        'search_charts',
        { query: 'garbled' },
        {
          text: 'not json',
        },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/malformed/i);
      expect(result.retryable).toBe(true);
    });

    it('reports a rejected indicator search', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'bad-ind' },
        {
          status: 400,
          json: { detail: 'nope' },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
    });
  });

  describe('search_indicators', () => {
    it('returns indicator ids, units and chart counts', async () => {
      const result = await callTool(
        server,
        'search_indicators',
        { query: 'free range eggs' },
        chartResponder(),
      );
      expect(result.ok).toBe(true);
      const indicator = result.result.structured.indicators[0];
      expect(indicator.indicatorId).toBe(1_269_972);
      expect(indicator.unit).toBe('eggs');
      expect(indicator.chartCount).toBe(1);
      // An empty description must not masquerade as a real one.
      expect(indicator.description).toBeNull();
    });

    it('forwards min_popularity', async () => {
      let seen = '';
      await callTool(
        server,
        'search_indicators',
        { query: 'eggs-pop', min_popularity: 0.5 },
        (url) => {
          seen = url;
          return { json: INDICATOR_SEARCH };
        },
      );
      expect(seen).toContain('min_popularity=0.5');
    });
  });

  describe('get_chart_data', () => {
    it('parses rows and joins units and citation from metadata', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'eggs-cage-free', countries: ['Canada', 'United States'] },
        chartResponder(),
      );
      expect(result.ok).toBe(true);
      const data = result.result.structured;
      expect(data.timeUnit).toBe('year');
      expect(data.columns[0].key).toBe('share_of_hens_cage_free');
      expect(data.columns[0].title).toBe('Share of hens in cage-free systems');
      expect(data.columns[0].unit).toBe('%');
      expect(data.columns[0].indicatorId).toBe(1_269_958);
      expect(data.rows).toHaveLength(3);
      expect(data.rows[0]).toEqual({
        entity: 'Canada',
        code: 'CAN',
        time: '2000',
        values: [12.5],
      });
      // An empty cell is a missing observation, not a zero.
      expect(data.rows[1].values[0]).toBeNull();
      expect(data.entities).toEqual(['Canada', 'United States']);
      expect(data.timeRange).toEqual({ first: '2000', last: '2001' });
      expect(data.attribution).toContain('European Commission');
      expect(result.result.text).toContain('Source: European Commission');
    });

    it('always asks for filtered CSV with short column names', async () => {
      let seen = '';
      await callTool(
        server,
        'get_chart_data',
        { slug: 'params-check', countries: ['Canada'] },
        (url) => {
          if (url.includes('.csv')) {
            seen = url;
            return { text: CSV };
          }
          return { json: METADATA };
        },
      );
      expect(seen).toContain('csvType=filtered');
      expect(seen).toContain('useColumnShortNames=true');
      // `csvType=full` is the API default and is megabytes on a large chart.
      expect(seen).not.toContain('csvType=full');
    });

    it('prefixes a leading tilde so a multi-word entity is not split', async () => {
      // THE regression test. Grapher splits `country` on `+`/space unless the
      // value contains a `~`, so `country=United States` silently returns an
      // empty table. A leading `~` is what keeps one entity intact.
      let seen = '';
      await callTool(
        server,
        'get_chart_data',
        { slug: 'tilde-check', countries: ['United States'] },
        (url) => {
          if (url.includes('.csv')) {
            seen = url;
            return { text: CSV };
          }
          return { json: METADATA };
        },
      );
      // `%7E` is `~` and `%20` is the space. Both forms are verified against
      // the live API; what matters is that a `+` never appears, because `+` is
      // grapher's other separator.
      expect(seen).toContain('country=%7EUnited%20States');
      expect(seen).not.toContain('+');
    });

    it('joins several entities with tildes', async () => {
      let seen = '';
      await callTool(
        server,
        'get_chart_data',
        { slug: 'tilde-multi', countries: ['Canada', 'United States'] },
        (url) => {
          if (url.includes('.csv')) {
            seen = url;
            return { text: CSV };
          }
          return { json: METADATA };
        },
      );
      expect(seen).toContain('country=%7ECanada%7EUnited%20States');
    });

    it('asks for the chart tab so `country` binds on a map-default chart', async () => {
      // `csvType=filtered` means "what the chart is showing". A chart whose
      // default view is the world map is showing EVERY country, and the
      // entity selection is not part of a map's state.
      let seen = '';
      await callTool(
        server,
        'get_chart_data',
        { slug: 'tab-check', countries: ['Canada'] },
        (url) => {
          if (url.includes('.csv')) {
            seen = url;
            return { text: CSV };
          }
          return { json: METADATA };
        },
      );
      expect(seen).toContain('tab=chart');
    });

    it('enforces the entity selection itself when the upstream ignores it', async () => {
      // A map-only chart returns every country whatever `country` says. The
      // tool must never present 250 countries under the one that was asked
      // for, so selection is applied here as well as requested there.
      const everyone = [
        'entity,code,year,share',
        'Afghanistan,AFG,2015,1',
        'Albania,ALB,2015,2',
        'Canada,CAN,2015,3',
        'Zimbabwe,ZWE,2015,4',
      ].join('\n');
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'map-only-chart', countries: ['Canada'] },
        chartResponder({ csv: { text: everyone } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.entities).toEqual(['Canada']);
      expect(result.result.structured.rows).toHaveLength(1);
      // totalRows counts the SELECTION, not what the upstream volunteered.
      expect(result.result.structured.totalRows).toBe(1);
      expect(result.result.structured.totalRowsBeforeSelection).toBe(4);
      expect(result.result.text).not.toContain('Zimbabwe');
    });

    it('selects by ISO code as well as by name', async () => {
      const everyone = 'entity,code,year,share\nCanada,CAN,2015,3\nJapan,JPN,2015,4';
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'code-select', countries: ['jpn'] },
        chartResponder({ csv: { text: everyone } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.entities).toEqual(['Japan']);
    });

    it('selects before truncating, so the wanted entity is never capped away', async () => {
      // The upstream leads with 200 other countries; a cap applied first would
      // return a full page of rows and none of them the one requested.
      const rows = [
        'entity,code,year,share',
        ...Array.from({ length: 50 }, (_, index) => `Other${index},O${index},2015,${index}`),
        'Canada,CAN,2015,99',
      ].join('\n');
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'select-then-cap', countries: ['Canada'], max_rows: 5 },
        chartResponder({ csv: { text: rows } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.rows).toHaveLength(1);
      expect(result.result.structured.rows[0].entity).toBe('Canada');
      expect(result.result.structured.truncated).toBe(false);
    });

    it('surfaces OWID’s non-redistributable refusal verbatim', async () => {
      const reason =
        'This chart contains non-redistributable data that we are not allowed to re-share and it therefore cannot be downloaded as a CSV.';
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'gbd-restricted' },
        chartResponder({ csv: { status: 403, json: { status: 403, error: reason } } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('non-redistributable');
      // The caller is told what still works instead of just being refused.
      expect(result.error).toContain('get_chart_metadata');
      expect(result.retryable).toBe(false);
    });

    it('points at search_charts when the slug is unknown', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'no-such-chart' },
        chartResponder({ csv: { status: 404, json: { status: 404, error: 'Not found' } } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('search_charts');
      expect(result.retryable).toBe(false);
    });

    it('diagnoses an empty result caused by a misspelled entity', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'empty-unknown', countries: ['United Kingdon'] },
        chartResponder({ csv: { text: 'Entity,Year,Share\n' } }),
      );
      expect(result.ok).toBe(true);
      const notes = result.result.structured.notes.join(' ');
      expect(notes).toContain('United Kingdon');
      expect(notes).toContain('United Kingdom');
    });

    it('says coverage, not spelling, when every entity is valid but empty', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'empty-valid', countries: ['Canada'] },
        chartResponder({ csv: { text: 'Entity,Year,Share\n' } }),
      );
      expect(result.ok).toBe(true);
      const notes = result.result.structured.notes.join(' ');
      expect(notes).toMatch(/no data in the requested range/i);
      expect(notes).not.toMatch(/did you mean/i);
    });

    it('truncates to max_rows and says so', async () => {
      const many = [
        'entity,code,year,share',
        ...Array.from({ length: 10 }, (_, index) => `Canada,CAN,${2000 + index},${index}`),
      ].join('\n');
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'truncate-check', max_rows: 4 },
        chartResponder({ csv: { text: many } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.rows).toHaveLength(4);
      expect(result.result.structured.totalRows).toBe(10);
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.structured.notes.join(' ')).toContain('max_rows');
    });

    it('reads a daily series as a day axis', async () => {
      const daily = 'entity,code,day,weekly_cases\nWorld,OWID_WRL,2020-03-01,1234';
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'daily-check' },
        chartResponder({ csv: { text: daily } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.timeUnit).toBe('day');
      expect(result.result.structured.rows[0].time).toBe('2020-03-01');
    });

    it('warns when OWID answers outside the requested time range', async () => {
      // Grapher snaps to the nearest available time rather than returning
      // nothing, so a year outside the request must never be relabelled.
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'snap-check', countries: ['Canada'], time: '1800..1810' },
        chartResponder({ csv: { text: 'entity,code,year,share\nCanada,CAN,1831,39.0' } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.notes.join(' ')).toMatch(/nearest available time/i);
    });

    it('repairs a lower-case ISO code and re-asks, rather than dropping the country', async () => {
      // Grapher's selector is case-sensitive: `~USA~jpn` returns the US only,
      // with a healthy 200 and no hint that Japan went missing.
      const asked = [];
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'case-repair', countries: ['USA', 'jpn'], time: '2010' },
        (url) => {
          if (url.includes('.csv')) {
            asked.push(decodeURIComponent(url));
            const repaired = url.includes('Japan');
            return {
              text: repaired
                ? 'entity,code,year,v\nUnited States,USA,2010,78.6\nJapan,JPN,2010,82.9'
                : 'entity,code,year,v\nUnited States,USA,2010,78.6',
            };
          }
          if (url.includes('api.ourworldindata.org')) {
            return {
              json: {
                ...INDICATOR,
                id: 424_242,
                dimensions: {
                  entities: {
                    values: [
                      { id: 1, name: 'United States', code: 'USA' },
                      { id: 2, name: 'Japan', code: 'JPN' },
                    ],
                  },
                },
              },
            };
          }
          return { json: metadataForIndicator(424_242) };
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.entities).toEqual(['United States', 'Japan']);
      expect(asked).toHaveLength(2);
      expect(asked[1]).toContain('Japan');
      expect(result.result.structured.notes.join(' ')).toMatch(/case-sensitive/i);
    });

    it('does not re-ask when nothing can be repaired', async () => {
      const asked = [];
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'no-repair', countries: ['Atlantis'], time: '2010' },
        (url) => {
          if (url.includes('.csv')) {
            asked.push(url);
            return { text: 'entity,code,year,v\n' };
          }
          if (url.includes('api.ourworldindata.org')) return { json: INDICATOR };
          return { json: METADATA };
        },
      );
      expect(result.ok).toBe(true);
      // One request only: a name that matches nothing is not worth re-asking.
      expect(asked).toHaveLength(1);
      expect(result.result.structured.notes.join(' ')).toContain('Atlantis');
    });

    it('does not mistake a BCE year for out-of-range', async () => {
      // "-10000" sliced to four characters is "-100", which sits outside its
      // own requested range and would raise a false snap warning on every
      // long-run series.
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'bce-check', countries: ['World'], time: '-10000..-5000' },
        chartResponder({
          csv: { text: 'entity,code,year,population\nWorld,OWID_WRL,-10000,4501152' },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.notes.join(' ')).not.toMatch(/nearest available/i);
    });

    it('orders a BCE time range forwards', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'bce-range', countries: ['World'] },
        chartResponder({
          csv: {
            text: 'entity,code,year,population\nWorld,OWID_WRL,-10000,1\nWorld,OWID_WRL,1750,2',
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.timeRange).toEqual({ first: '-10000', last: '1750' });
    });

    it('ignores whitespace-only country entries', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'blank-country', countries: ['   '] },
        chartResponder(),
      );
      expect(result.ok).toBe(true);
      // No usable selection means no selection — not an empty table.
      expect(result.result.structured.rows.length).toBeGreaterThan(0);
    });

    it('caps the rows spelled out in text while keeping them all in structured', async () => {
      const many = [
        'entity,code,year,share',
        ...Array.from({ length: 120 }, (_, index) => `Canada,CAN,${1900 + index},${index}`),
      ].join('\n');
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'text-cap', max_rows: 200 },
        chartResponder({ csv: { text: many } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.rows).toHaveLength(120);
      expect(result.result.text).toContain('more row(s)');
      expect(result.result.text.split('\n').length).toBeLessThan(80);
    });

    it('still returns data when the metadata request fails', async () => {
      const result = await callTool(server, 'get_chart_data', { slug: 'meta-down' }, (url) =>
        url.includes('.csv') ? { text: CSV } : { status: 500, text: 'boom' },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.rows).toHaveLength(3);
      // No metadata means no units — but the numbers still arrive.
      expect(result.result.structured.columns[0].unit).toBeNull();
      expect(result.result.structured.title).toBe('meta-down');
    });

    it('refuses an oversized body and says which knob to turn', async () => {
      const huge = `entity,code,year,v\n${'Canada,CAN,2000,1\n'.repeat(250_000)}`;
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'too-big' },
        chartResponder({ csv: { text: huge } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/too large/i);
      expect(result.error).toContain('countries');
      expect(result.retryable).toBe(false);
    });

    it('maps a 400 to a time-format complaint, not a generic failure', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'bad-params' },
        chartResponder({ csv: { status: 400, json: { status: 400, error: 'bad' } } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/time range/i);
      expect(result.retryable).toBe(false);
    });

    it('treats an unparseable body as an upstream problem, not an empty result', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'html-body' },
        chartResponder({ csv: { text: '<html><body>maintenance</body></html>' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unrecognised format/i);
      // A shape we do not understand may well be transient.
      expect(result.retryable).toBe(true);
    });

    it('survives malformed indicator metadata on the diagnosis path', async () => {
      const result = await callTool(
        server,
        'get_chart_data',
        { slug: 'bad-indicator', countries: ['Nowhere'] },
        chartResponder({
          csv: { text: 'entity,code,year,v\n' },
          metadata: { json: metadataForIndicator(515_151) },
          indicator: { text: 'not json at all' },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.notes.join(' ')).toMatch(/check the spelling/i);
    });

    it('rejects a malformed time argument before any request', async () => {
      const result = await callTool(server, 'get_chart_data', {
        slug: 'x',
        time: 'last tuesday',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('get_chart_metadata', () => {
    it('reports units, definitions and every upstream licence', async () => {
      const result = await callTool(
        server,
        'get_chart_metadata',
        { slug: 'eggs-meta' },
        chartResponder(),
      );
      expect(result.ok).toBe(true);
      const view = result.result.structured;
      expect(view.columns[0].unit).toBe('%');
      expect(view.columns[0].timespan).toBe('1996-2025');
      expect(view.columns[0].nextUpdate).toBe('2027-06-11');
      expect(view.sources).toHaveLength(2);
      expect(view.sources.map((s) => s.license)).toEqual(['CC BY 4.0', 'OGL v3.0']);
      expect(view.nonRedistributable).toBe(false);
      expect(result.result.text).toContain('OGL v3.0');
      expect(result.result.text).toMatch(/third-party/i);
    });

    it('flags a non-redistributable chart and explains the consequence', async () => {
      // A DIFFERENT indicator id on purpose: the egress cache is keyed by URL
      // and outlives a single tool call, so reusing 1269958 here would be
      // served the earlier (redistributable) fixture from cache.
      const restrictedId = 1_165_388;
      const result = await callTool(
        server,
        'get_chart_metadata',
        { slug: 'gbd-meta' },
        chartResponder({
          metadata: {
            json: {
              ...METADATA,
              columns: {
                'Death rate from infectious diseases': {
                  titleShort: 'Death rate from infectious diseases',
                  shortName: 'infectious_death_rate',
                  unit: 'deaths per 100,000',
                  owidVariableId: restrictedId,
                },
              },
            },
          },
          indicator: {
            json: { ...INDICATOR, id: restrictedId, nonRedistributable: true },
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.nonRedistributable).toBe(true);
      expect(result.result.structured.notes.join(' ')).toContain('get_chart_data will refuse');
    });

    it('does not report a refused metadata request as a bad slug', async () => {
      // OWID serves metadata even for charts whose DATA is restricted, so a
      // 403 here means something else — reporting it as "no such chart" would
      // send the caller off renaming a slug that was correct all along.
      const result = await callTool(
        server,
        'get_chart_metadata',
        { slug: 'blocked-meta' },
        { status: 403, json: { status: 403, error: 'Forbidden' } },
      );
      expect(result.ok).toBe(false);
      expect(result.error).not.toMatch(/no our world in data chart/i);
      expect(result.error).toContain('403');
    });

    it('errors helpfully on an unknown slug', async () => {
      const result = await callTool(
        server,
        'get_chart_metadata',
        { slug: 'nope-meta' },
        { status: 404, json: { status: 404, error: 'Not found' } },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('search_charts');
    });
  });
});

describe('chart CSV parsing', () => {
  it('handles quoted fields containing commas', () => {
    const table = parseChartCsv('entity,code,year,v\n"Bonaire, Sint Eustatius",BES,2020,1.5');
    expect(table?.rows[0]?.entity).toBe('Bonaire, Sint Eustatius');
    expect(table?.rows[0]?.values).toEqual([1.5]);
  });

  it('handles escaped quotes and CRLF line endings', () => {
    const table = parseChartCsv('entity,year,v\r\n"He said ""hi""",2020,2\r\n');
    expect(table?.rows).toHaveLength(1);
    expect(table?.rows[0]?.entity).toBe('He said "hi"');
  });

  it('strips a byte-order mark before matching headers', () => {
    const table = parseChartCsv('﻿entity,code,year,v\nCanada,CAN,2020,1');
    expect(table?.columns).toEqual(['v']);
    expect(table?.rows[0]?.entity).toBe('Canada');
  });

  it('copes with the Code column being absent', () => {
    const table = parseChartCsv('Entity,Year,Life expectancy\nHigh-income countries,2000,77.6');
    expect(table?.rows[0]?.code).toBeNull();
    expect(table?.rows[0]?.values).toEqual([77.6]);
  });

  it('accepts title-case headers', () => {
    const table = parseChartCsv('Entity,Code,Year,Life expectancy\nCanada,CAN,2000,79.2');
    expect(table?.timeUnit).toBe('year');
    expect(table?.columns).toEqual(['Life expectancy']);
  });

  it('keeps a non-numeric value as text rather than coercing it', () => {
    const table = parseChartCsv('entity,code,year,status\nCanada,CAN,2020,High income');
    expect(table?.rows[0]?.values).toEqual(['High income']);
  });

  it('drops a truncated row rather than inventing missing values', () => {
    const table = parseChartCsv('entity,code,year,a,b\nCanada,CAN,2020,1,2\nCanada,CAN');
    expect(table?.rows).toHaveLength(1);
  });

  it('returns undefined for a body that is not a chart CSV', () => {
    expect(parseChartCsv('<html>nope</html>')).toBeUndefined();
    expect(parseChartCsv('')).toBeUndefined();
  });
});
