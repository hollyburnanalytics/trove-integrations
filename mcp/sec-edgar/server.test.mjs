import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// Realistic efts.sec.gov full-text search body (the shape server.ts parses).
const SEARCH_BODY = {
  hits: {
    total: { value: 42 },
    hits: [
      {
        _id: '0000320193-23-000106:aapl-20230930.htm',
        _source: {
          display_names: ['Apple Inc. (AAPL) (CIK 0000320193)'],
          form: '10-K',
          file_date: '2023-11-03',
        },
      },
      {
        // No `form` — server falls back to `file_type` (the exhibit type).
        _id: '0000320193-23-000077:ex-21.htm',
        _source: {
          display_names: ['Apple Inc. (AAPL)'],
          file_type: 'EX-21.1',
          file_date: '2023-08-04',
        },
      },
    ],
  },
};

// Realistic www.sec.gov/files/company_tickers.json body.
const TICKER_MAP = {
  0: { cik_str: 320_193, ticker: 'AAPL', title: 'Apple Inc.' },
  1: { cik_str: 789_019, ticker: 'MSFT', title: 'Microsoft Corp' },
};

// Realistic data.sec.gov submissions body (parallel-array `recent` shape).
const SUBMISSIONS_BODY = {
  name: 'Apple Inc.',
  filings: {
    recent: {
      form: ['10-K', '8-K', '10-Q'],
      filingDate: ['2023-11-03', '2023-10-26', '2023-08-04'],
      accessionNumber: ['0000320193-23-000106', '0000320193-23-000097', '0000320193-23-000077'],
      primaryDocument: ['aapl-20230930.htm', 'a8k.htm', 'aapl-20230701.htm'],
      primaryDocDescription: ['10-K', '', '10-Q'],
    },
  },
};

describe('sec-edgar MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'company_filings',
      'search_filings',
    ]);
  });

  describe('search_filings', () => {
    it('returns parsed filings with company, form, date, and accession', async () => {
      const result = await callTool(
        server,
        'search_filings',
        { query: 'climate risk' },
        {
          json: SEARCH_BODY,
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.query).toBe('climate risk');
      expect(s.total).toBe(42);
      expect(s.count).toBe(2);
      expect(s.filings[0]).toEqual({
        company: 'Apple Inc. (AAPL) (CIK 0000320193)',
        form: '10-K',
        filedDate: '2023-11-03',
        accession: '0000320193-23-000106',
      });
      // Second hit has no `form`, so it falls back to `file_type`.
      expect(s.filings[1].form).toBe('EX-21.1');
      expect(s.filings[1].accession).toBe('0000320193-23-000077');
      expect(result.result.text).toContain('Apple Inc. (AAPL)');
    });

    it('passes query, forms, and date range to the EDGAR endpoint', async () => {
      let requested = '';
      await callTool(
        server,
        'search_filings',
        {
          query: 'climate risk',
          forms: '10-K,10-Q',
          startDate: '2022-01-01',
          endDate: '2022-12-31',
        },
        (url) => {
          requested = url;
          return { json: SEARCH_BODY };
        },
      );
      expect(requested).toContain('efts.sec.gov/LATEST/search-index');
      expect(requested).toContain('q=climate+risk');
      expect(requested).toContain('forms=10-K%2C10-Q');
      expect(requested).toContain('dateRange=custom');
      expect(requested).toContain('startdt=2022-01-01');
      expect(requested).toContain('enddt=2022-12-31');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_filings',
        { query: 'asdfqwerty' },
        {
          json: { hits: { total: { value: 0 }, hits: [] } },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.total).toBe(0);
      expect(result.result.text).toMatch(/No EDGAR filings matching/i);
    });

    it('maps a 404 to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'search_filings', { query: 'x' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no record/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'search_filings', { query: 'x' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_filings', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a malformed startDate before fetching', async () => {
      const result = await callTool(server, 'search_filings', {
        query: 'x',
        startDate: '01/01/2022',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('company_filings', () => {
    it('resolves a ticker and lists recent filings', async () => {
      const result = await callTool(server, 'company_filings', { company: 'AAPL' }, (url) => {
        if (url.includes('company_tickers.json')) return { json: TICKER_MAP };
        if (url.includes('/submissions/CIK')) return { json: SUBMISSIONS_BODY };
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.company).toBe('Apple Inc.');
      expect(s.cik).toBe('0000320193');
      expect(s.count).toBe(3);
      expect(s.filings[0]).toEqual({
        form: '10-K',
        filedDate: '2023-11-03',
        accession: '0000320193-23-000106',
        primaryDocument: 'aapl-20230930.htm',
        description: '10-K',
      });
      // Empty primaryDocDescription becomes null.
      expect(s.filings[1].description).toBeNull();
      expect(result.result.text).toContain('Apple Inc. (CIK 0000320193)');
    });

    it('accepts a numeric CIK directly and zero-pads it', async () => {
      let submissionsUrl = '';
      const result = await callTool(server, 'company_filings', { company: '320193' }, (url) => {
        if (url.includes('company_tickers.json')) {
          throw new Error('should not fetch the ticker map for a numeric CIK');
        }
        if (url.includes('/submissions/CIK')) {
          submissionsUrl = url;
          return { json: SUBMISSIONS_BODY };
        }
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      expect(submissionsUrl).toContain('CIK0000320193.json');
      expect(result.result.structured.cik).toBe('0000320193');
    });

    it('honors the limit argument', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '320193', limit: 2 },
        {
          json: SUBMISSIONS_BODY,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.filings).toHaveLength(2);
    });

    it('errors (non-retryable) when a ticker has no match', async () => {
      const result = await callTool(server, 'company_filings', { company: 'NOPE' }, (url) => {
        if (url.includes('company_tickers.json')) return { json: TICKER_MAP };
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/No SEC company found/i);
    });

    it('reports cleanly when a company has no recent filings', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '320193' },
        {
          json: { name: 'Apple Inc.', filings: { recent: {} } },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/No recent filings/i);
    });

    it('maps a 404 on submissions to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '320193' },
        { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('maps a 500 on submissions to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '320193' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'company_filings', { company: 'AAPL', limit: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
