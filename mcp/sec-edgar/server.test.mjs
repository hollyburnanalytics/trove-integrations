import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// NOTE: the server keeps an in-isolate response cache keyed by URL that
// persists across tests, so any two tests that need DIFFERENT bodies for the
// same endpoint must use different CIKs / queries (error statuses are never
// cached, so 4xx/5xx tests may reuse a CIK).

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

// Realistic www.sec.gov/files/company_tickers_exchange.json body.
const TICKER_MAP = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [320_193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
    [789_019, 'Microsoft Corp', 'MSFT', 'Nasdaq'],
    [1_067_983, 'Berkshire Hathaway Inc', 'BRK-B', 'NYSE'],
  ],
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

// --- XBRL fixture builders (data.sec.gov companyfacts / companyconcept) -----

/** One raw XBRL fact in the data.sec.gov shape; override any field. */
const fact = (over = {}) => ({
  start: '2022-10-01',
  end: '2023-09-30',
  val: 100,
  accn: '0001-23-000001',
  fy: 2023,
  fp: 'FY',
  form: '10-K',
  filed: '2023-11-03',
  ...over,
});

/** An instant (balance-sheet) fact: no `start`. */
const instant = (over = {}) => {
  const built = fact(over);
  delete built.start;
  return built;
};

const usd = (facts) => ({ units: { USD: facts } });

const companyFacts = (cik, gaap) => ({
  cik,
  entityName: 'Testco Inc.',
  facts: { 'us-gaap': gaap },
});

// A two-year annual fixture exercising fallbacks, amendments, and identity.
const ANNUAL_FACTS = companyFacts(100_001, {
  NetIncomeLoss: usd([
    fact({ val: 100 }),
    // Same window re-reported in an amendment — its value must win…
    fact({ val: 105, form: '10-K/A', filed: '2024-01-15' }),
    // …while the prior fiscal year stays its own period.
    fact({
      start: '2021-10-02',
      end: '2022-09-30',
      val: 90,
      fy: 2022,
      filed: '2022-11-01',
      accn: '0001-22-000001',
    }),
    // A nine-month YTD figure — must never masquerade as a quarter or a year.
    fact({ start: '2023-01-01', end: '2023-09-30', val: 75, fp: 'Q3' }),
  ]),
  // Only the legacy tag exists — `revenue` must fall back to it.
  Revenues: usd([fact({ val: 500 })]),
  // No GrossProfit tag — it must be derived as revenue - costOfRevenue.
  CostOfGoodsAndServicesSold: usd([fact({ val: 200 })]),
  Assets: usd([instant({ val: 350 })]),
  Liabilities: usd([instant({ val: 290 })]),
  StockholdersEquity: usd([instant({ val: 60 })]),
  NetCashProvidedByUsedInOperatingActivities: usd([fact({ val: 120 })]),
  PaymentsToAcquirePropertyPlantAndEquipment: usd([fact({ val: 20 })]),
  EarningsPerShareDiluted: { units: { 'USD/shares': [fact({ val: 2.5 })] } },
});

// A foreign-private-issuer style fixture: the quarter arrives in a 6-K.
const QUARTERLY_FACTS = companyFacts(100_002, {
  NetIncomeLoss: usd([
    fact({
      start: '2023-07-02',
      end: '2023-09-30',
      val: 25,
      fp: 'Q3',
      form: '6-K',
      filed: '2023-10-15',
    }),
    fact({ val: 100 }), // annual — excluded from a quarterly request
  ]),
});

const MISMATCH_FACTS = companyFacts(100_003, {
  NetIncomeLoss: usd([fact()]),
  Assets: usd([instant({ val: 350 })]),
  Liabilities: usd([instant({ val: 200 })]),
  StockholdersEquity: usd([instant({ val: 100 })]),
});

const REPORTED_TOTAL_FACTS = companyFacts(100_004, {
  NetIncomeLoss: usd([fact()]),
  Assets: usd([instant({ val: 350 })]),
  // Sides don't sum (NCI etc.) but the reported combined total matches.
  Liabilities: usd([instant({ val: 200 })]),
  StockholdersEquity: usd([instant({ val: 100 })]),
  LiabilitiesAndStockholdersEquity: usd([instant({ val: 350 })]),
});

// A prior-year comparative re-reported in a later 10-Q: it carries the LATER
// filing's fy/fp stamps, which must not be trusted as the window's label.
const COMPARATIVE_FACTS = companyFacts(100_016, {
  NetIncomeLoss: usd([
    fact({
      start: '2025-07-01',
      end: '2025-09-30',
      val: 30,
      fy: 2025,
      fp: 'Q3',
      form: '10-Q',
      filed: '2025-11-04',
    }),
    fact({
      start: '2024-07-01',
      end: '2024-09-30',
      val: 20,
      fy: 2025, // the 2025 filing's stamp — wrong for a 2024 window
      fp: 'Q3',
      form: '10-Q',
      filed: '2025-11-04',
    }),
  ]),
});

// A filer that reports trailing-twelve-month figures inside its 10-Qs
// (year-long windows ending at quarter ends, stamped as quarters).
const TTM_FACTS = companyFacts(100_018, {
  NetIncomeLoss: usd([
    // The real fiscal year.
    fact({
      start: '2025-01-01',
      end: '2025-12-31',
      val: 100,
      fy: 2025,
      fp: 'FY',
      filed: '2026-02-06',
    }),
    // TTM window from the Q1 10-Q — annual-length, but NOT a fiscal year.
    fact({
      start: '2025-04-01',
      end: '2026-03-31',
      val: 110,
      fy: 2026,
      fp: 'Q1',
      form: '10-Q',
      filed: '2026-04-30',
    }),
  ]),
});

// A foreign filer: full EUR history plus one convenience-USD fact.
const EURO_FACTS = companyFacts(100_017, {
  NetIncomeLoss: {
    units: {
      EUR: [
        fact({ val: 10 }),
        fact({ start: '2021-10-02', end: '2022-09-30', val: 9, fy: 2022, filed: '2022-11-01' }),
      ],
      USD: [fact({ val: 11 })],
    },
  },
});

const CONCEPT_BODY = {
  cik: 100_006,
  taxonomy: 'us-gaap',
  tag: 'NetIncomeLoss',
  label: 'Net Income (Loss) Attributable to Parent',
  description: 'The portion of profit or loss…',
  entityName: 'Testco Inc.',
  units: {
    USD: [
      fact({ val: 100 }),
      fact({ val: 105, form: '10-K/A', filed: '2024-01-15' }), // dupe window, later filed
      fact({
        start: '2021-10-02',
        end: '2022-09-30',
        val: 90,
        fy: 2022,
        filed: '2022-11-01',
      }),
      fact({ start: '2023-07-02', end: '2023-09-30', val: 25, fp: 'Q3', form: '10-Q' }),
    ],
  },
};

/** Route a request URL to a canned body, erroring on anything unexpected. */
const routes = (table) => (url) => {
  for (const [needle, body] of Object.entries(table)) {
    if (url.includes(needle)) return body;
  }
  throw new Error(`unexpected url ${url}`);
};

describe('sec-edgar MCP server', () => {
  it('lists the eight tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'company_filings',
      'get_company',
      'get_filing_document',
      'get_financials',
      'get_fund_holdings',
      'get_xbrl_concept',
      'insider_transactions',
      'search_filings',
    ]);
  });

  describe('get_financials', () => {
    it('assembles annual statements: fallback tags, amendments, identity, FCF', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100001' },
        routes({ '/api/xbrl/companyfacts/CIK0000100001.json': { json: ANNUAL_FACTS } }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.company).toBe('Testco Inc.');
      expect(s.cik).toBe('0000100001');
      expect(s.taxonomy).toBe('us-gaap');
      expect(s.currency).toBe('USD');
      expect(s.count).toBe(2);

      const [fy2023, fy2022] = s.periods;
      expect(fy2023.label).toBe('FY2023');
      // Labels/provenance come from the ORIGINAL filing…
      expect(fy2023.form).toBe('10-K');
      expect(fy2023.filed).toBe('2023-11-03');
      // …values from the latest amendment.
      expect(fy2023.incomeStatement.netIncome).toBe(105);
      // Revenue resolved through the legacy `Revenues` fallback tag.
      expect(fy2023.incomeStatement.revenue).toBe(500);
      // No GrossProfit tag in the fixture — derived from revenue - cost.
      expect(fy2023.incomeStatement.grossProfit).toBe(300);
      expect(fy2023.incomeStatement.epsDiluted).toBe(2.5);
      expect(fy2023.balanceSheet.totalAssets).toBe(350);
      expect(fy2023.identityOk).toBe(true);
      expect(fy2023.cashFlow.freeCashFlow).toBe(100); // 120 OCF - 20 capex
      expect(fy2022.label).toBe('FY2022');
      expect(fy2022.incomeStatement.netIncome).toBe(90);
      expect(fy2022.identityOk).toBeNull(); // no FY2022 balance sheet in fixture
      expect(result.result.text).toContain('FY2023');
    });

    it('never presents a 9-month YTD window as an annual period', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100001', limit: 12 },
        routes({ '/api/xbrl/companyfacts/CIK0000100001.json': { json: ANNUAL_FACTS } }),
      );
      const ends = result.result.structured.periods.map((p) => `${p.start}|${p.end}`);
      expect(ends).not.toContain('2023-01-01|2023-09-30');
      expect(result.result.structured.count).toBe(2);
    });

    it('honors limit', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100001', limit: 1 },
        routes({ '/api/xbrl/companyfacts/CIK0000100001.json': { json: ANNUAL_FACTS } }),
      );
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.periods[0].label).toBe('FY2023');
    });

    it('includes quarters furnished on 6-K (foreign private issuers)', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100002', period: 'quarterly' },
        routes({ '/api/xbrl/companyfacts/CIK0000100002.json': { json: QUARTERLY_FACTS } }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.count).toBe(1);
      expect(s.periods[0].label).toBe('Q3 FY2023');
      expect(s.periods[0].form).toBe('6-K');
      expect(s.periods[0].incomeStatement.netIncome).toBe(25);
    });

    it('flags a balance sheet that does not balance', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100003' },
        routes({ '/api/xbrl/companyfacts/CIK0000100003.json': { json: MISMATCH_FACTS } }),
      );
      const period = result.result.structured.periods[0];
      expect(period.identityOk).toBe(false);
      expect(period.identityDelta).toBe(50); // 350 - (200 + 100)
      expect(result.result.text).toContain('A≠L+E');
    });

    it('prefers the reported liabilities+equity total for the identity check', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100004' },
        routes({ '/api/xbrl/companyfacts/CIK0000100004.json': { json: REPORTED_TOTAL_FACTS } }),
      );
      expect(result.result.structured.periods[0].identityOk).toBe(true);
    });

    it('excludes trailing-twelve-month windows from annual periods', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100018' },
        routes({ '/api/xbrl/companyfacts/CIK0000100018.json': { json: TTM_FACTS } }),
      );
      const s = result.result.structured;
      expect(s.count).toBe(1); // only the real fiscal year survives
      expect(s.periods[0].label).toBe('FY2025');
      expect(s.periods[0].end).toBe('2025-12-31');
    });

    it('does not trust comparative fy/fp stamps from later filings', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100016', period: 'quarterly' },
        routes({ '/api/xbrl/companyfacts/CIK0000100016.json': { json: COMPARATIVE_FACTS } }),
      );
      const [current, comparative] = result.result.structured.periods;
      expect(current.label).toBe('Q3 FY2025');
      expect(comparative.label).toBe('Q ending 2024-09-30');
      expect(comparative.fiscalYear).toBeNull();
      expect(comparative.incomeStatement.netIncome).toBe(20);
    });

    it('reports in the dominant currency, not a convenience-USD sliver', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100017' },
        routes({ '/api/xbrl/companyfacts/CIK0000100017.json': { json: EURO_FACTS } }),
      );
      const s = result.result.structured;
      expect(s.currency).toBe('EUR');
      expect(s.count).toBe(2); // the full EUR history, not the single USD fact
      expect(s.periods[0].incomeStatement.netIncome).toBe(10);
    });

    it('resolves tickers through the SEC ticker map', async () => {
      let factsUrl = '';
      const result = await callTool(server, 'get_financials', { company: 'AAPL' }, (url) => {
        if (url.includes('company_tickers_exchange.json')) return { json: TICKER_MAP };
        if (url.includes('/api/xbrl/companyfacts/')) {
          factsUrl = url;
          return { json: { ...ANNUAL_FACTS, cik: 320_193 } };
        }
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      expect(factsUrl).toContain('CIK0000320193.json');
    });

    it('maps a missing companyfacts record to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_financials',
        { company: '100005' },
        { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no XBRL company facts/i);
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'get_financials', { company: 'AAPL', limit: 99 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_xbrl_concept', () => {
    it('dedupes repeat windows to the latest filing and sorts newest first', async () => {
      const result = await callTool(
        server,
        'get_xbrl_concept',
        { company: '100006', concept: 'NetIncomeLoss' },
        routes({
          '/api/xbrl/companyconcept/CIK0000100006/us-gaap/NetIncomeLoss.json': {
            json: CONCEPT_BODY,
          },
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.label).toBe('Net Income (Loss) Attributable to Parent');
      expect(s.unit).toBe('USD');
      expect(s.total).toBe(3); // 4 raw facts, 1 duplicate window collapsed
      // Newest window first; the amended value won its window.
      expect(s.facts[0].end).toBe('2023-09-30');
      expect(s.facts.find((f) => f.start === '2022-10-01').value).toBe(105);
      // Annual fiscal stamps render as "FY2023", not "FY FY2023".
      expect(result.result.text).toContain('(FY2023, 10-K/A)');
      expect(result.result.text).toContain('(Q3 FY2023, 10-Q)');
    });

    it('filters to annual windows', async () => {
      const result = await callTool(
        server,
        'get_xbrl_concept',
        { company: '100006', concept: 'NetIncomeLoss', period: 'annual' },
        routes({
          '/api/xbrl/companyconcept/CIK0000100006/us-gaap/NetIncomeLoss.json': {
            json: CONCEPT_BODY,
          },
        }),
      );
      const s = result.result.structured;
      expect(s.count).toBe(2);
      expect(s.facts.every((f) => f.start !== '2023-07-02')).toBe(true);
    });

    it('maps an unknown concept to a helpful non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_xbrl_concept',
        { company: '100007', concept: 'NotARealTag' },
        { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/case-sensitive/i);
    });

    it('rejects a malformed concept before fetching', async () => {
      const result = await callTool(server, 'get_xbrl_concept', {
        company: 'AAPL',
        concept: 'net income',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('search_filings', () => {
    it('returns parsed filings with company, form, date, and accession', async () => {
      const result = await callTool(
        server,
        'search_filings',
        { query: 'climate risk' },
        { json: SEARCH_BODY },
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
      // 2 hits consumed of 42 total → next page starts at 2.
      expect(s.nextFrom).toBe(2);
      expect(result.result.text).toContain('Apple Inc. (AAPL)');
    });

    it('passes query, forms, date range, and offset to the EDGAR endpoint', async () => {
      let requested = '';
      await callTool(
        server,
        'search_filings',
        {
          query: 'supply chain',
          forms: '10-K,10-Q',
          startDate: '2022-01-01',
          endDate: '2022-12-31',
          from: 20,
        },
        (url) => {
          requested = url;
          return { json: SEARCH_BODY };
        },
      );
      expect(requested).toContain('efts.sec.gov/LATEST/search-index');
      expect(requested).toContain('q=supply+chain');
      expect(requested).toContain('forms=10-K%2C10-Q');
      expect(requested).toContain('dateRange=custom');
      expect(requested).toContain('startdt=2022-01-01');
      expect(requested).toContain('enddt=2022-12-31');
      expect(requested).toContain('from=20');
    });

    it('scopes to one filer via ciks when company is given', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'search_filings',
        { query: 'ciks scope test', company: 'AAPL' },
        (url) => {
          if (url.includes('company_tickers_exchange.json')) return { json: TICKER_MAP };
          requested = url;
          return { json: SEARCH_BODY };
        },
      );
      expect(requested).toContain('ciks=0000320193');
      expect(result.result.structured.cik).toBe('0000320193');
    });

    it('dedupes multiple document hits from the same filing', async () => {
      const twoDocumentsOneFiling = {
        hits: {
          total: { value: 2 },
          hits: [
            {
              _id: '0000320193-23-000106:aapl-20230930.htm',
              _source: {
                display_names: ['Apple Inc.'],
                form: '10-K',
                file_date: '2023-11-03',
              },
            },
            {
              _id: '0000320193-23-000106:ex-21.htm',
              _source: {
                display_names: ['Apple Inc.'],
                file_type: 'EX-21.1',
                file_date: '2023-11-03',
              },
            },
          ],
        },
      };
      const result = await callTool(
        server,
        'search_filings',
        { query: 'dedupe test' },
        { json: twoDocumentsOneFiling },
      );
      const s = result.result.structured;
      expect(s.count).toBe(1);
      expect(s.filings[0].form).toBe('10-K');
      expect(s.nextFrom).toBeNull(); // both raw hits consumed, total reached
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_filings',
        { query: 'asdfqwerty' },
        { json: { hits: { total: { value: 0 }, hits: [] } } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.nextFrom).toBeNull();
      expect(result.result.text).toMatch(/No EDGAR filings matching/i);
    });

    it('maps a 404 to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'search_filings', { query: 'x404' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/rejected that query/i);
    });

    it('maps a persistent 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'search_filings', { query: 'x500' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps rate-limiting (429) to a retryable TOOL_ERROR', async () => {
      const result = await callTool(server, 'search_filings', { query: 'x429' }, { status: 429 });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate-limiting/i);
    });

    it('recovers when a transient error clears before the retry budget', async () => {
      let calls = 0;
      const result = await callTool(server, 'search_filings', { query: 'flaky test' }, () => {
        calls += 1;
        return calls < 3 ? { status: 503 } : { json: SEARCH_BODY };
      });
      expect(result.ok).toBe(true);
      expect(calls).toBe(3);
      expect(result.result.structured.total).toBe(42);
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
        if (url.includes('company_tickers_exchange.json')) return { json: TICKER_MAP };
        if (url.includes('/submissions/CIK')) return { json: SUBMISSIONS_BODY };
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.company).toBe('Apple Inc.');
      expect(s.cik).toBe('0000320193');
      expect(s.count).toBe(3);
      expect(s.matched).toBe(3);
      expect(s.filings[0]).toMatchObject({
        form: '10-K',
        filedDate: '2023-11-03',
        accession: '0000320193-23-000106',
        primaryDocument: 'aapl-20230930.htm',
        description: '10-K',
      });
      expect(s.filings[0].items).toBeNull();
      // Empty primaryDocDescription becomes null.
      expect(s.filings[1].description).toBeNull();
      expect(result.result.text).toContain('Apple Inc. (CIK 0000320193)');
    });

    it('normalizes share-class dots when matching tickers', async () => {
      let submissionsUrl = '';
      const result = await callTool(server, 'company_filings', { company: 'BRK.B' }, (url) => {
        if (url.includes('company_tickers_exchange.json')) return { json: TICKER_MAP };
        if (url.includes('/submissions/CIK')) {
          submissionsUrl = url;
          return { json: { name: 'Berkshire Hathaway Inc', filings: { recent: {} } } };
        }
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      expect(submissionsUrl).toContain('CIK0001067983.json');
    });

    it('resolves a company name when no ticker matches', async () => {
      const result = await callTool(server, 'company_filings', { company: 'Microsoft' }, (url) => {
        if (url.includes('company_tickers_exchange.json')) return { json: TICKER_MAP };
        if (url.includes('/submissions/CIK0000789019')) {
          return { json: { name: 'Microsoft Corp', filings: { recent: {} } } };
        }
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      expect(result.result.structured.cik).toBe('0000789019');
    });

    it('accepts a numeric CIK directly and zero-pads it', async () => {
      let submissionsUrl = '';
      const result = await callTool(server, 'company_filings', { company: '100015' }, (url) => {
        if (url.includes('company_tickers_exchange.json')) {
          throw new Error('should not fetch the ticker map for a numeric CIK');
        }
        if (url.includes('/submissions/CIK')) {
          submissionsUrl = url;
          return { json: SUBMISSIONS_BODY };
        }
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(true);
      expect(submissionsUrl).toContain('CIK0000100015.json');
      expect(result.result.structured.cik).toBe('0000100015');
    });

    it('filters by form types', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '100010', forms: '10-K, 10-q' },
        routes({ '/submissions/CIK0000100010.json': { json: SUBMISSIONS_BODY } }),
      );
      const s = result.result.structured;
      expect(s.matched).toBe(2);
      expect(s.filings.map((f) => f.form)).toEqual(['10-K', '10-Q']);
    });

    it('filters by filing-date range', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '100011', startDate: '2023-09-01', endDate: '2023-10-31' },
        routes({ '/submissions/CIK0000100011.json': { json: SUBMISSIONS_BODY } }),
      );
      const s = result.result.structured;
      expect(s.matched).toBe(1);
      expect(s.filings[0].form).toBe('8-K');
    });

    it('honors the limit argument', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '100012', limit: 2 },
        routes({ '/submissions/CIK0000100012.json': { json: SUBMISSIONS_BODY } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.matched).toBe(3);
    });

    it('errors (non-retryable) when nothing matches the company', async () => {
      const result = await callTool(server, 'company_filings', { company: 'ZZZZZZ' }, (url) => {
        if (url.includes('company_tickers_exchange.json')) return { json: TICKER_MAP };
        throw new Error(`unexpected url ${url}`);
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/No SEC company found/i);
    });

    it('reports cleanly when filters match nothing', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '100013', forms: 'S-1' },
        routes({ '/submissions/CIK0000100013.json': { json: SUBMISSIONS_BODY } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/No recent filings matching those filters/i);
    });

    it('maps a 404 on submissions to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '100014' },
        { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'company_filings', { company: 'AAPL', limit: 999 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});

// --- Fixtures for the v1.2 tools ---------------------------------------------

const FORM4_XML = `<ownershipDocument>
  <periodOfReport>2026-06-15</periodOfReport>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-15</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>250</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const INSIDER_SUBMISSIONS = {
  name: 'Testco Inc.',
  filings: {
    recent: {
      form: ['4', '10-Q', '4'],
      filingDate: ['2026-06-17', '2026-05-01', '2026-05-20'],
      accessionNumber: ['0000000020-26-000001', '0000000020-26-000900', '0000000020-26-000002'],
      primaryDocument: ['xslF345X06/form4.xml', 'q.htm', 'xslF345X06/form4.xml'],
      primaryDocDescription: ['FORM 4', '10-Q', 'FORM 4'],
    },
  },
};

const FUND_SUBMISSIONS = {
  name: 'Test Capital LP',
  filings: {
    recent: {
      form: ['13F-HR', '4'],
      filingDate: ['2026-05-15', '2026-05-01'],
      accessionNumber: ['0000000021-26-000001', '0000000021-26-000900'],
      primaryDocument: ['xslForm13F_X02/primary_doc.xml', 'x.xml'],
      primaryDocDescription: ['13F-HR', ''],
    },
  },
};

const FUND_INDEX = {
  directory: {
    item: [
      { name: 'primary_doc.xml', size: 5000 },
      { name: 'infotable.xml', size: 40_000 },
    ],
  },
};

const FUND_COVER_XML = `<edgarSubmission><formData><coverPage>
  <periodOfReport>03-31-2026</periodOfReport>
  <filingManager><name>Test Capital LP</name></filingManager>
  <reportType>13F HOLDINGS REPORT</reportType></coverPage>
  <summaryPage><tableValueTotal>9000000</tableValueTotal></summaryPage>
</formData></edgarSubmission>`;

const FUND_TABLE_XML = `<informationTable>
  <infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>037833100</cusip>
    <value>6000000</value><shrsOrPrnAmt><sshPrnamt>30000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
  <infoTable><nameOfIssuer>ALLY FINL INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>02005N100</cusip>
    <value>3000000</value><shrsOrPrnAmt><sshPrnamt>76000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
</informationTable>`;

const DOC_SUBMISSIONS = {
  name: 'Testco Inc.',
  filings: {
    recent: {
      form: ['10-K'],
      filingDate: ['2026-02-01'],
      accessionNumber: ['0000000022-26-000001'],
      primaryDocument: ['main10k.htm'],
      primaryDocDescription: ['10-K'],
    },
  },
};

const DOC_INDEX = {
  directory: {
    item: [
      { name: 'main10k.htm', size: 5000 },
      { name: 'ex-99.pdf', size: 900 },
      { name: '0000000022-26-000001-index.html', size: 100 },
    ],
  },
};

const DOC_HTML =
  '<html><body><p>Annual report of Testco.</p><p>Our risk factors include weather.</p></body></html>';

const PROFILE_SUBMISSIONS = {
  name: 'Testco Inc.',
  cik: '100023',
  tickers: ['TST'],
  exchanges: ['Nasdaq'],
  sic: '3571',
  sicDescription: 'Electronic Computers',
  entityType: 'operating',
  category: 'Large accelerated filer',
  stateOfIncorporation: 'DE',
  fiscalYearEnd: '0926',
  website: 'https://testco.example',
  phone: '(555) 555-5555',
  formerNames: [
    {
      name: 'TESTCO COMPUTER INC',
      from: '2007-01-10T05:00:00.000Z',
      to: '2019-08-05T04:00:00.000Z',
    },
  ],
  filings: { recent: {} },
};

const ITEMS_SUBMISSIONS = {
  name: 'Testco Inc.',
  filings: {
    recent: {
      form: ['8-K'],
      filingDate: ['2026-05-01'],
      accessionNumber: ['0000000024-26-000001'],
      primaryDocument: ['a8k.htm'],
      primaryDocDescription: ['8-K'],
      items: ['2.02,9.01'],
    },
  },
};

describe('sec-edgar v1.2 tools', () => {
  describe('insider_transactions', () => {
    it('decodes Form 4 filings and summarizes open-market activity', async () => {
      const result = await callTool(
        server,
        'insider_transactions',
        { company: '100020', limit: 2 },
        routes({
          '/submissions/CIK0000100020.json': { json: INSIDER_SUBMISSIONS },
          '/Archives/edgar/data/100020/000000002026000001/form4.xml': { text: FORM4_XML },
          '/Archives/edgar/data/100020/000000002026000002/form4.xml': { text: FORM4_XML },
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.count).toBe(2); // the 10-Q between the two Form 4s is skipped
      expect(s.filings[0].owners).toEqual(['Doe Jane']);
      expect(s.filings[0].officerTitle).toBe('CFO');
      expect(s.filings[0].transactions[0].codeDescription).toBe('Open-market sale');
      expect(s.summary.openMarketSales.shares).toBe(2000);
      expect(s.summary.netShares).toBe(-2000);
      expect(result.result.text).toContain('Open-market sale');
    });

    it('reports cleanly when there are no ownership filings', async () => {
      const result = await callTool(
        server,
        'insider_transactions',
        { company: '100025' },
        routes({
          '/submissions/CIK0000100025.json': {
            json: { name: 'Testco Inc.', filings: { recent: {} } },
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/No recent/i);
    });
  });

  describe('get_fund_holdings', () => {
    it('finds the info table, normalizes values, and ranks holdings', async () => {
      const result = await callTool(
        server,
        'get_fund_holdings',
        { company: '100021' },
        routes({
          '/submissions/CIK0000100021.json': { json: FUND_SUBMISSIONS },
          '/Archives/edgar/data/100021/000000002126000001/index.json': { json: FUND_INDEX },
          '/Archives/edgar/data/100021/000000002126000001/primary_doc.xml': {
            text: FUND_COVER_XML,
          },
          '/Archives/edgar/data/100021/000000002126000001/infotable.xml': {
            text: FUND_TABLE_XML,
          },
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.company).toBe('Test Capital LP');
      expect(s.periodOfReport).toBe('2026-03-31');
      expect(s.valueUnits).toBe('dollars');
      expect(s.totalValue).toBe(9_000_000);
      expect(s.totalCheckOk).toBe(true);
      expect(s.holdings[0].issuer).toBe('APPLE INC');
      expect(s.holdings[0].percent).toBeCloseTo(66.67, 1);
      expect(result.result.text).toContain('APPLE INC');
    });

    it('explains 13F-NT notice filers', async () => {
      const result = await callTool(
        server,
        'get_fund_holdings',
        { company: '100026' },
        routes({
          '/submissions/CIK0000100026.json': {
            json: {
              name: 'Notice Filer LP',
              filings: {
                recent: {
                  form: ['13F-NT'],
                  filingDate: ['2026-05-15'],
                  accessionNumber: ['0000000026-26-000001'],
                  primaryDocument: ['primary_doc.xml'],
                  primaryDocDescription: [''],
                },
              },
            },
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/13F-NT/);
    });
  });

  describe('get_filing_document', () => {
    const documentRoutes = routes({
      '/submissions/CIK0000100022.json': { json: DOC_SUBMISSIONS },
      '/Archives/edgar/data/100022/000000002226000001/index.json': { json: DOC_INDEX },
      '/Archives/edgar/data/100022/000000002226000001/main10k.htm': { text: DOC_HTML },
    });

    it('reads the primary document as clean paginated text', async () => {
      const result = await callTool(
        server,
        'get_filing_document',
        { company: '100022', accession: '0000000022-26-000001' },
        documentRoutes,
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.document).toBe('main10k.htm');
      expect(s.content).toContain('Annual report of Testco.');
      expect(s.content).not.toContain('<p>');
      expect(s.nextOffset).toBeNull();
      // The EDGAR wrapper index page is not listed as a document.
      expect(s.documents.map((d) => d.name)).toEqual(['main10k.htm', 'ex-99.pdf']);
    });

    it('locates literal matches with offsets', async () => {
      const result = await callTool(
        server,
        'get_filing_document',
        { company: '100022', accession: '0000000022-26-000001', find: 'risk factors' },
        documentRoutes,
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.matches).toHaveLength(1);
      expect(s.matches[0].context).toContain('risk factors include weather');
    });

    it('refuses binary attachments with a helpful error', async () => {
      const result = await callTool(
        server,
        'get_filing_document',
        { company: '100022', accession: '0000000022-26-000001', document: 'ex-99.pdf' },
        documentRoutes,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/PDF/);
    });

    it('errors helpfully for an unknown document name', async () => {
      const result = await callTool(
        server,
        'get_filing_document',
        { company: '100022', accession: '0000000022-26-000001', document: 'nope.htm' },
        documentRoutes,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Available: main10k.htm/);
    });
  });

  describe('get_company', () => {
    it('returns the registrant profile', async () => {
      const result = await callTool(
        server,
        'get_company',
        { company: '100023' },
        routes({ '/submissions/CIK0000100023.json': { json: PROFILE_SUBMISSIONS } }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.company).toBe('Testco Inc.');
      expect(s.sicDescription).toBe('Electronic Computers');
      expect(s.fiscalYearEnd).toBe('09-26');
      expect(s.formerNames).toEqual([
        { name: 'TESTCO COMPUTER INC', from: '2007-01-10', to: '2019-08-05' },
      ]);
      expect(result.result.text).toContain('TST (Nasdaq)');
    });
  });

  describe('company_filings 8-K items', () => {
    it('decodes 8-K item codes to event labels', async () => {
      const result = await callTool(
        server,
        'company_filings',
        { company: '100024' },
        routes({ '/submissions/CIK0000100024.json': { json: ITEMS_SUBMISSIONS } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.filings[0].items).toBe('2.02,9.01');
      expect(result.result.text).toContain('2.02 Results of operations (earnings)');
    });
  });
});
