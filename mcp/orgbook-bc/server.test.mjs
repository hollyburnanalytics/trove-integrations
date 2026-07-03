import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/**
 * Acceptance suite for the orgbook-bc server. OrgBook is keyless, so unlike
 * jonas-premier there is no auth lifecycle — the interesting surfaces are the
 * v4 search-result mapping (names[] / attributes[] arrays → one flat entity
 * record, with status/type code translation), the exact-match discipline of
 * the registration-number lookup (search is fuzzy; get_entity must not return
 * a near miss), and the credential-set history flattening.
 */

/** A v4 search-result row shaped after the live API (probed 2026-07). */
const ENTITY_ROW = {
  id: 975_001,
  source_id: 'BC0112233',
  type: 'registration.registries.ca',
  names: [
    { id: 1, text: 'NORTHGATE BUILDERS LTD.', type: 'entity_name' },
    { id: 2, text: '123456782', type: 'business_number' },
  ],
  addresses: [],
  attributes: [
    { id: 10, type: 'registration_date', format: 'datetime', value: '2012-12-14T01:27:59+00:00' },
    { id: 11, type: 'entity_status', format: 'category', value: 'ACT' },
    { id: 12, type: 'entity_type', format: 'category', value: 'BC' },
    { id: 13, type: 'home_jurisdiction', format: 'jurisdiction', value: 'BC' },
  ],
};

/** A second, near-miss row (different source_id) for exact-match tests. */
const NEAR_MISS_ROW = {
  ...ENTITY_ROW,
  id: 111_111,
  source_id: 'BC0112234',
  names: [{ id: 3, text: 'NORTHGATE BUILDERS (2020) LTD.', type: 'entity_name' }],
};

/** A historical sole-proprietorship row for code-translation tests. */
const HISTORICAL_ROW = {
  id: 222_222,
  source_id: 'FM0445566',
  names: [{ id: 4, text: 'EXAMPLE FORM MODELING CO.', type: 'entity_name' }],
  attributes: [
    { id: 20, type: 'entity_status', format: 'category', value: 'HIS' },
    { id: 21, type: 'entity_type', format: 'category', value: 'SP' },
  ],
};

const searchBody = (results, total = results.length) => ({
  json: { total, page_size: 10, page: 1, results },
});

/** A credential-set body: original registration (superseded) + name change. */
const CREDENTIAL_SETS = [
  {
    id: 1,
    latest_credential_id: 99,
    credentials: [
      {
        id: 98,
        credential_type: { schema_label: { en: { label: 'Registration' } } },
        effective_date: '2012-12-13T17:27:59-08:00',
        latest: false,
        revoked: true,
        revoked_date: '2019-06-02T00:00:00-08:00',
        names: [{ id: 5, text: 'OLD NORTHGATE HOLDINGS LTD.', type: 'entity_name' }],
        attributes: [{ id: 30, type: 'entity_status', format: 'category', value: 'ACT' }],
      },
      {
        id: 99,
        credential_type: { schema_label: { en: { label: 'Registration' } } },
        effective_date: '2019-06-02T00:00:00-08:00',
        latest: true,
        revoked: false,
        names: [{ id: 6, text: 'NORTHGATE BUILDERS LTD.', type: 'entity_name' }],
        attributes: [{ id: 31, type: 'entity_status', format: 'category', value: 'ACT' }],
      },
    ],
  },
];

describe('orgbook-bc MCP server', () => {
  it('lists the three read-only tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_entity',
      'get_entity_history',
      'search_entities',
    ]);
    for (const tool of server.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  describe('search_entities', () => {
    it('maps names/attributes into flat entity records with code translation', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'search_entities',
        { query: 'northgate builders', page: 2, pageSize: 25 },
        (url) => {
          requested = url;
          return searchBody([ENTITY_ROW, HISTORICAL_ROW], 42);
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.total).toBe(42);
      expect(s.count).toBe(2);
      expect(s.entities[0]).toEqual({
        topicId: 975_001,
        registrationNumber: 'BC0112233',
        entityName: 'NORTHGATE BUILDERS LTD.',
        businessNumber: '123456782',
        entityStatus: 'Active',
        entityType: 'BC Company',
        homeJurisdiction: 'BC',
        registrationDate: '2012-12-14T01:27:59+00:00',
        url: 'https://orgbook.gov.bc.ca/entity/BC0112233',
      });
      expect(s.entities[1]).toMatchObject({
        registrationNumber: 'FM0445566',
        entityStatus: 'Historical',
        entityType: 'Sole Proprietorship',
      });
      expect(result.result.text).toContain('NORTHGATE BUILDERS LTD.');
      expect(result.result.text).toContain('[Active · BC Company]');
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/api/v4/search/topic');
      expect(decoded).toContain('q=northgate+builders');
      expect(decoded).toContain('page=2');
      expect(decoded).toContain('page_size=25');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_entities',
        { query: 'zzz no such thing' },
        searchBody([], 0),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no bc registrations/i);
    });

    it('maps a 500 to a retryable error and rejects an empty query upfront', async () => {
      const broken = await callTool(server, 'search_entities', { query: 'x' }, { status: 500 });
      expect(broken.ok).toBe(false);
      expect(broken.retryable).toBe(true);

      const invalid = await callTool(server, 'search_entities', { query: '' });
      expect(invalid.ok).toBe(false);
      expect(invalid.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_entity', () => {
    it('returns only the exact source_id match, case-insensitively', async () => {
      const result = await callTool(
        server,
        'get_entity',
        { registrationNumber: 'bc0112233' },
        searchBody([NEAR_MISS_ROW, ENTITY_ROW]),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.registrationNumber).toBe('BC0112233');
      expect(s.entityName).toBe('NORTHGATE BUILDERS LTD.');
      expect(s.businessNumber).toBe('123456782');
      expect(result.result.text).toContain('Status: Active');
      expect(result.result.text).toContain('BN 123456782');
      expect(result.result.text).toContain('https://orgbook.gov.bc.ca/entity/BC0112233');
    });

    it('fails clearly when only near misses come back', async () => {
      const result = await callTool(
        server,
        'get_entity',
        { registrationNumber: 'BC0000001' },
        searchBody([NEAR_MISS_ROW]),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/No BC registration "BC0000001"/);
      expect(result.error).toMatch(/search_entities/);
    });
  });

  describe('get_entity_history', () => {
    it('resolves the registration then flattens the credential timeline', async () => {
      const urls = [];
      const result = await callTool(
        server,
        'get_entity_history',
        { registrationNumber: 'BC0112233' },
        (url) => {
          urls.push(url);
          if (url.includes('/api/v4/search/topic')) return searchBody([ENTITY_ROW]);
          if (url.includes('/api/v4/topic/975001/credential-set')) {
            return { json: CREDENTIAL_SETS };
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.registrationNumber).toBe('BC0112233');
      expect(s.entityName).toBe('NORTHGATE BUILDERS LTD.');
      expect(s.count).toBe(2);
      expect(s.credentials[0]).toEqual({
        type: 'Registration',
        effectiveDate: '2012-12-13T17:27:59-08:00',
        latest: false,
        revoked: true,
        revokedDate: '2019-06-02T00:00:00-08:00',
        names: [{ text: 'OLD NORTHGATE HOLDINGS LTD.', type: 'entity_name' }],
        attributes: [{ type: 'entity_status', value: 'ACT' }],
      });
      expect(s.credentials[1].revoked).toBe(false);
      expect(result.result.text).toContain('OLD NORTHGATE HOLDINGS LTD.');
      expect(result.result.text).toContain('(superseded)');
      expect(urls.some((u) => u.includes('/topic/975001/credential-set'))).toBe(true);
    });

    it('maps a credential-set 404 to a clear non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_entity_history',
        { registrationNumber: 'BC0112233' },
        (url) => {
          if (url.includes('/api/v4/search/topic')) return searchBody([ENTITY_ROW]);
          return { status: 404, text: 'not found' };
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/No credential history/);
    });
  });
});
