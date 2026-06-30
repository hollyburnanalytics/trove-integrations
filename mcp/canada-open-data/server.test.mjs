import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** Wrap a CKAN `result` payload in the success envelope the API returns. */
const ckanOk = (result) => ({ json: { success: true, result } });

const SEARCH_RESULT = {
  count: 142,
  results: [
    {
      name: 'preliminary-housing-starts',
      title_translated: { en: 'Preliminary Housing Starts', fr: 'Mises en chantier' },
      title: 'Preliminary Housing Starts (legacy)',
      organization: { title: 'Canada Mortgage and Housing Corporation | SCHL' },
      resources: [{ format: 'csv' }, { format: 'CSV' }, { format: 'xlsx' }],
      num_resources: 3,
      metadata_modified: '2026-03-14T12:34:56.789012',
    },
    {
      name: 'building-permits',
      title: 'Building Permits',
      organization: { title: 'Statistics Canada | Statistique Canada' },
      resources: [],
      num_resources: 0,
      metadata_modified: '2026-01-02T00:00:00',
    },
  ],
};

const PACKAGE_SHOW_RESULT = {
  name: 'preliminary-housing-starts',
  title_translated: { en: 'Preliminary Housing Starts' },
  notes_translated: { en: 'Monthly   preliminary   housing-starts figures.' },
  organization: { title: 'Canada Mortgage and Housing Corporation | SCHL' },
  resources: [
    {
      id: 'res-abc-123',
      name: { en: 'Starts 2026 CSV' },
      format: 'csv',
      url: 'https://example.statcan.gc.ca/starts.csv',
      datastore_active: true,
    },
    {
      id: 'res-def-456',
      name: { en: 'Methodology PDF' },
      format: 'pdf',
      url: 'https://example.cmhc.ca/methodology.pdf',
      datastore_active: false,
    },
  ],
};

const DATASTORE_RESULT = {
  total: 1200,
  fields: [
    { id: '_id', type: 'int' },
    { id: 'region', type: 'text' },
    { id: 'starts', type: 'numeric' },
  ],
  records: [
    { _id: 1, region: 'British Columbia', starts: 3421 },
    { _id: 2, region: 'Ontario', starts: 8765 },
  ],
};

const ORG_AUTOCOMPLETE_RESULT = [
  { name: 'statcan', title: 'Statistics Canada | Statistique Canada' },
  { name: 'cmhc-schl', title: 'Canada Mortgage and Housing Corporation | SCHL' },
];

describe('canada-open-data MCP server', () => {
  it('lists the four tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'find_organizations',
      'get_dataset',
      'query_dataset',
      'search_datasets',
    ]);
  });

  describe('search_datasets', () => {
    it('returns datasets with English titles, formats, and slugs', async () => {
      const result = await callTool(
        server,
        'search_datasets',
        { query: 'housing starts', organization: 'cmhc', format: 'csv', sort: 'recent', limit: 5 },
        ckanOk(SEARCH_RESULT),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.total).toBe(142);
      expect(s.count).toBe(2);
      expect(s.datasets[0]).toMatchObject({
        slug: 'preliminary-housing-starts',
        title: 'Preliminary Housing Starts',
        organization: 'Canada Mortgage and Housing Corporation',
        numResources: 3,
        modified: '2026-03-14',
        landingUrl: 'https://open.canada.ca/data/en/dataset/preliminary-housing-starts',
      });
      // Distinct, upper-cased formats.
      expect(s.datasets[0].formats.toSorted()).toEqual(['CSV', 'XLSX']);
      expect(s.datasets[1].organization).toBe('Statistics Canada');
      expect(result.result.text).toContain('2 of 142 dataset(s)');
    });

    it('builds a single space-joined fq with the requested filters and sort', async () => {
      let requested = '';
      await callTool(
        server,
        'search_datasets',
        {
          query: 'permits',
          organization: 'statcan',
          format: 'geojson',
          collection: 'primary',
          sort: 'recent',
        },
        (url) => {
          requested = url;
          return ckanOk(SEARCH_RESULT);
        },
      );
      const parsed = new URL(requested);
      expect(parsed.pathname).toContain('/package_search');
      const fq = parsed.searchParams.get('fq');
      expect(fq).toContain('organization:statcan');
      expect(fq).toContain('res_format:GEOJSON'); // uppercased
      expect(fq).toContain('jurisdiction:federal'); // default applied
      expect(fq).toContain('collection:primary');
      expect(parsed.searchParams.get('sort')).toBe('metadata_modified desc');
    });

    it('omits the jurisdiction clause when set to any and defaults q to *:*', async () => {
      let requested = '';
      await callTool(server, 'search_datasets', { jurisdiction: 'any' }, (url) => {
        requested = url;
        return ckanOk(SEARCH_RESULT);
      });
      const parsed = new URL(requested);
      expect(parsed.searchParams.get('q')).toBe('*:*');
      expect(parsed.searchParams.get('fq')).toBeNull();
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_datasets',
        { query: 'zzz' },
        ckanOk({ count: 0, results: [] }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({ total: 0, count: 0, datasets: [] });
      expect(result.result.text).toMatch(/no datasets matched/i);
    });

    it('maps a 503 to a retryable tool error', async () => {
      const result = await callTool(server, 'search_datasets', { query: 'x' }, { status: 503 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/temporarily unavailable/i);
    });

    it('surfaces a success:false envelope (HTTP 200) as a non-retryable error', async () => {
      const result = await callTool(
        server,
        'search_datasets',
        { query: 'x' },
        {
          json: {
            success: false,
            error: { message: 'Solr query failed', __type: 'Search Query Error' },
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/Solr query failed/);
    });

    it('rejects an out-of-range limit before fetching', async () => {
      const result = await callTool(server, 'search_datasets', { query: 'x', limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an invalid jurisdiction enum value', async () => {
      const result = await callTool(server, 'search_datasets', { jurisdiction: 'national' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_dataset', () => {
    it('returns metadata and resources with queryable flags', async () => {
      const result = await callTool(
        server,
        'get_dataset',
        { id: 'preliminary-housing-starts' },
        ckanOk(PACKAGE_SHOW_RESULT),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.title).toBe('Preliminary Housing Starts');
      expect(s.organization).toBe('Canada Mortgage and Housing Corporation');
      expect(s.description).toBe('Monthly preliminary housing-starts figures.'); // whitespace collapsed
      expect(s.landingUrl).toBe(
        'https://open.canada.ca/data/en/dataset/preliminary-housing-starts',
      );
      expect(s.resources).toHaveLength(2);
      expect(s.resources[0]).toEqual({
        name: 'Starts 2026 CSV',
        format: 'CSV',
        url: 'https://example.statcan.gc.ca/starts.csv',
        queryable: true,
        resourceId: 'res-abc-123',
      });
      expect(s.resources[1].queryable).toBe(false);
      expect(result.result.text).toContain('(queryable)');
    });

    it('passes the id through to package_show', async () => {
      let requested = '';
      await callTool(server, 'get_dataset', { id: 'building-permits' }, (url) => {
        requested = url;
        return ckanOk(PACKAGE_SHOW_RESULT);
      });
      const parsed = new URL(requested);
      expect(parsed.pathname).toContain('/package_show');
      expect(parsed.searchParams.get('id')).toBe('building-permits');
    });

    it('maps a 404 (CKAN not-found envelope) to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_dataset',
        { id: 'does-not-exist' },
        {
          status: 404,
          json: { success: false, error: { message: 'Not found', __type: 'Not Found Error' } },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/Not found/);
    });

    it('rejects an empty id before fetching', async () => {
      const result = await callTool(server, 'get_dataset', { id: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('query_dataset', () => {
    it('returns rows and fields (dropping the _id column)', async () => {
      const result = await callTool(
        server,
        'query_dataset',
        { resourceId: 'res-abc-123', limit: 20 },
        ckanOk(DATASTORE_RESULT),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.resourceId).toBe('res-abc-123');
      expect(s.total).toBe(1200);
      expect(s.fields).toEqual(['region', 'starts']); // _id filtered out
      expect(s.records).toHaveLength(2);
      expect(s.records[0]).toEqual({ _id: 1, region: 'British Columbia', starts: 3421 });
      expect(result.result.text).toContain('2 of 1200 row(s)');
    });

    it('passes resource_id, limit, and optional q to datastore_search', async () => {
      let requested = '';
      await callTool(
        server,
        'query_dataset',
        { resourceId: 'res-abc-123', q: 'Ontario', limit: 5 },
        (url) => {
          requested = url;
          return ckanOk(DATASTORE_RESULT);
        },
      );
      const parsed = new URL(requested);
      expect(parsed.pathname).toContain('/datastore_search');
      expect(parsed.searchParams.get('resource_id')).toBe('res-abc-123');
      expect(parsed.searchParams.get('limit')).toBe('5');
      expect(parsed.searchParams.get('q')).toBe('Ontario');
    });

    it('reports an empty record set cleanly', async () => {
      const result = await callTool(
        server,
        'query_dataset',
        { resourceId: 'res-abc-123' },
        ckanOk({ total: 0, fields: [{ id: 'region' }], records: [] }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({
        resourceId: 'res-abc-123',
        total: 0,
        fields: ['region'],
        records: [],
      });
      expect(result.result.text).toMatch(/no rows/i);
    });

    it('re-wraps a non-DataStore error as a non-retryable guidance error', async () => {
      // A 404 CKAN envelope from datastore_search => the handler catches and
      // re-throws a non-retryable "not row-queryable" ToolError.
      const result = await callTool(
        server,
        'query_dataset',
        { resourceId: 'res-file-only' },
        {
          status: 404,
          json: {
            success: false,
            error: { message: 'Resource was not found.', __type: 'Not Found Error' },
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/not row-queryable/i);
      expect(result.error).toContain('res-file-only');
    });

    it('also makes a transient 500 non-retryable for this tool (caught and re-wrapped)', async () => {
      const result = await callTool(
        server,
        'query_dataset',
        { resourceId: 'res-abc-123' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/not row-queryable/i);
    });

    it('rejects an out-of-range limit before fetching', async () => {
      const result = await callTool(server, 'query_dataset', {
        resourceId: 'res-abc-123',
        limit: 51,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('find_organizations', () => {
    it('resolves a keyword to organization slugs with English titles', async () => {
      const result = await callTool(
        server,
        'find_organizations',
        { query: 'statistics' },
        ckanOk(ORG_AUTOCOMPLETE_RESULT),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.query).toBe('statistics');
      expect(s.count).toBe(2);
      expect(s.organizations[0]).toEqual({ slug: 'statcan', title: 'Statistics Canada' });
      expect(s.organizations[1]).toEqual({
        slug: 'cmhc-schl',
        title: 'Canada Mortgage and Housing Corporation',
      });
      expect(result.result.text).toContain('statcan');
    });

    it('passes query and limit to organization_autocomplete', async () => {
      let requested = '';
      await callTool(server, 'find_organizations', { query: 'health', limit: 3 }, (url) => {
        requested = url;
        return ckanOk(ORG_AUTOCOMPLETE_RESULT);
      });
      const parsed = new URL(requested);
      expect(parsed.pathname).toContain('/organization_autocomplete');
      expect(parsed.searchParams.get('q')).toBe('health');
      expect(parsed.searchParams.get('limit')).toBe('3');
    });

    it('reports no matches cleanly', async () => {
      const result = await callTool(server, 'find_organizations', { query: 'zzz' }, ckanOk([]));
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({ query: 'zzz', count: 0, organizations: [] });
      expect(result.result.text).toMatch(/no departments/i);
    });

    it('maps a 503 to a retryable error', async () => {
      const result = await callTool(
        server,
        'find_organizations',
        { query: 'health' },
        { status: 503 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'find_organizations', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
