import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { extractFilingText, filterFilings, sync } from './index.mjs';

function makeContext(cursor, config = {}) {
  return { log: { info: mock(), warn: mock() }, progress: mock(), config, cursor };
}

// Mock SEC ticker map response
const TICKER_MAP_RESPONSE = {
  0: { cik_str: 1_234_567, ticker: 'TEST', title: 'TEST CORP' },
  1: { cik_str: 7_654_321, ticker: 'OTHER', title: 'OTHER INC' },
};

// Mock submissions response with parallel arrays. The EDGAR submissions API
// names each filing's primary document directly via the primaryDocument array.
const SUBMISSIONS_RESPONSE = {
  name: 'Test Corp',
  filings: {
    recent: {
      accessionNumber: [
        '0001234567-25-000001',
        '0001234567-25-000002',
        '0001234567-24-000003',
        '0001234567-23-000004',
      ],
      filingDate: ['2025-11-15', '2025-08-10', '2024-03-01', '2023-06-15'],
      reportDate: ['2025-09-30', '2025-06-30', '2024-12-31', '2023-03-31'],
      form: ['10-Q', '10-Q', '10-K', '4'],
      primaryDocument: ['test-20250930.htm', 'test-20250630.htm', 'test-20241231.htm', 'form4.htm'],
    },
  },
};

const FILING_HTML = `<html><body>
<h1>ANNUAL REPORT</h1>
<p>This is a test annual report for Test Corp with substantial content that should be extracted by the parser.</p>
<p>Item 1. Business overview describing the company operations in detail with enough text to pass the minimum threshold.</p>
<p>Item 7. Management discussion and analysis of financial condition with detailed quarterly comparisons and forward guidance.</p>
</body></html>`;

/**
 * Build a fetch mock covering the ticker map, submissions, and filing HTML.
 * Accepts overrides for the submissions payload and filing HTML.
 */
function mockFetchForSync({ submissions = SUBMISSIONS_RESPONSE, html = FILING_HTML } = {}) {
  fetch.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('company_tickers.json')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(TICKER_MAP_RESPONSE) });
    }
    if (typeof url === 'string' && url.includes('data.sec.gov/submissions')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(submissions) });
    }
    if (typeof url === 'string' && url.includes('/Archives/edgar/') && url.endsWith('.htm')) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(html) });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

describe('sec-filings connector', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });

  afterEach(() => jest.restoreAllMocks());

  it('warns when no tickers configured', async () => {
    const context = makeContext(undefined, {});
    const result = await sync(context);
    expect(context.log.warn).toHaveBeenCalledWith('No tickers configured');
    expect(result.documents).toEqual([]);
    expect(result.stats.fetched).toBe(0);
  });

  it('fetches filings for a ticker', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));

    // Should have 3 filings (2x 10-Q + 1x 10-K, form "4" is excluded)
    expect(result.documents).toHaveLength(3);
    expect(result.stats.fetched).toBe(3);
    expect(result.documents[0].title).toContain('Test Corp');
    expect(result.documents[0].title).toContain('10-Q');
    expect(result.documents[0].tags).toContain('10-Q');
    expect(result.documents[0].tags).toContain('TEST');
  });

  it('builds the document URL from the API primary document', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    expect(result.documents[0].url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1234567/000123456725000001/test-20250930.htm',
    );
  });

  it('uses cursor to skip old filings', async () => {
    mockFetchForSync();

    // Set cursor to 2025-01-01 — should skip the 2024-03-01 10-K
    const cursor = { type: 'date', value: '2025-01-01T00:00:00.000Z' };
    const result = await sync(makeContext(cursor, { tickers: ['TEST'] }));

    expect(result.documents).toHaveLength(2);
    expect(result.stats.skipped).toBe(1);
    // Only the two 2025 10-Q filings
    expect(result.documents.every((document) => document.tags.includes('10-Q'))).toBe(true);
  });

  it('advances cursor to max filing date', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));

    expect(result.cursor).toBeTruthy();
    expect(result.cursor.value).toBe(new Date('2025-11-15').toISOString());
  });

  it('warns on unknown ticker and continues', async () => {
    mockFetchForSync();

    const context = makeContext(undefined, { tickers: ['UNKNOWN', 'TEST'] });
    const result = await sync(context);

    expect(context.log.warn).toHaveBeenCalledWith('Unknown ticker: UNKNOWN');
    // Should still process TEST successfully
    expect(result.documents.length).toBeGreaterThan(0);
  });

  it('handles submissions API error gracefully', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('company_tickers.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(TICKER_MAP_RESPONSE) });
      }
      if (typeof url === 'string' && url.includes('data.sec.gov/submissions')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const context = makeContext(undefined, { tickers: ['TEST'] });
    const result = await sync(context);

    expect(context.log.warn).toHaveBeenCalled();
    expect(result.documents).toEqual([]);
  });

  it('handles filing fetch error and continues to next filing', async () => {
    let htmlFetchCount = 0;
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('company_tickers.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(TICKER_MAP_RESPONSE) });
      }
      if (typeof url === 'string' && url.includes('data.sec.gov/submissions')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSIONS_RESPONSE) });
      }
      if (typeof url === 'string' && url.includes('/Archives/edgar/') && url.endsWith('.htm')) {
        htmlFetchCount++;
        // First filing HTML fetch fails, rest succeed
        if (htmlFetchCount === 1) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve(FILING_HTML) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const context = makeContext(undefined, { tickers: ['TEST'] });
    const result = await sync(context);

    // First of 3 filings failed, so 2 should succeed
    expect(result.documents).toHaveLength(2);
    expect(context.log.warn).toHaveBeenCalled();
  });

  it('skips filings with too little extractable text', async () => {
    mockFetchForSync({
      submissions: {
        name: 'Test Corp',
        filings: {
          recent: {
            accessionNumber: ['0001234567-25-000001'],
            filingDate: ['2025-11-15'],
            reportDate: ['2025-09-30'],
            form: ['10-Q'],
            primaryDocument: ['test-20250930.htm'],
          },
        },
      },
      html: '<html><body><p>Hi</p></body></html>',
    });

    const context = makeContext(undefined, { tickers: ['TEST'] });
    const result = await sync(context);

    expect(result.documents).toHaveLength(0);
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('too little text'));
  });

  it('warns when a filing has no HTML primary document', async () => {
    mockFetchForSync({
      submissions: {
        name: 'Test Corp',
        filings: {
          recent: {
            accessionNumber: ['0001234567-25-000001'],
            filingDate: ['2025-11-15'],
            reportDate: ['2025-09-30'],
            form: ['10-K'],
            primaryDocument: [''],
          },
        },
      },
    });

    const context = makeContext(undefined, { tickers: ['TEST'] });
    const result = await sync(context);

    expect(result.documents).toHaveLength(0);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('No HTML primary document'),
    );
  });

  it('generates stable document IDs from accession numbers', async () => {
    mockFetchForSync();

    const result1 = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    const result2 = await sync(makeContext(undefined, { tickers: ['TEST'] }));

    expect(result1.documents[0].id).toBe(result2.documents[0].id);
    expect(result1.documents[0].id).toMatch(/^sec-/);
  });

  it('includes filing metadata in document text', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    const document = result.documents[0];

    expect(document.text).toContain('Test Corp 10-Q');
    expect(document.text).toContain('Filed:');
    expect(document.text).toContain('Period:');
    expect(document.url).toContain('sec.gov/Archives/edgar/data/');
  });

  it('handles submissions with no company name', async () => {
    mockFetchForSync({
      submissions: {
        name: '',
        filings: {
          recent: {
            accessionNumber: ['0001234567-25-000001'],
            filingDate: ['2025-11-15'],
            reportDate: ['2025-09-30'],
            form: ['10-K'],
            primaryDocument: ['test-20241231.htm'],
          },
        },
      },
    });

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    expect(result.documents).toHaveLength(1);
    // Should use name from ticker map since submissions name is empty
    expect(result.documents[0].author).toBe('TEST CORP');
  });

  it('handles filing with invalid date gracefully', async () => {
    mockFetchForSync({
      submissions: {
        name: 'Test Corp',
        filings: {
          recent: {
            accessionNumber: ['0001234567-25-000001'],
            filingDate: ['not-a-date'],
            reportDate: [''],
            form: ['10-K'],
            primaryDocument: ['test-20241231.htm'],
          },
        },
      },
    });

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    // Filing should still be processed (invalid dates don't get filtered by cursor)
    expect(result.documents).toHaveLength(1);
    // Date should fall back to current date since safeDate returns undefined for invalid
    expect(result.documents[0].date).toBeTruthy();
  });

  it('normalizes ticker to uppercase', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['test'] }));
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.documents[0].tags).toContain('TEST');
  });
});

describe('filterFilings', () => {
  const filings = [
    { accessionNumber: '001', filingDate: '2025-06-01', form: '10-K' },
    { accessionNumber: '002', filingDate: '2025-03-01', form: '10-Q' },
    { accessionNumber: '003', filingDate: '2025-01-01', form: '4' },
    { accessionNumber: '004', filingDate: '2024-06-01', form: 'S-1' },
    { accessionNumber: '005', filingDate: '2024-01-01', form: '10-K' },
  ];

  it('filters to allowed filing types', () => {
    const result = filterFilings(filings);
    expect(result).toHaveLength(4); // 10-K, 10-Q, S-1, 10-K (not "4")
    expect(result.map((filing) => filing.form)).toEqual(['10-K', '10-Q', 'S-1', '10-K']);
  });

  it('filters by date cursor', () => {
    const result = filterFilings(filings, new Date('2025-01-01'));
    expect(result).toHaveLength(2); // Only 10-K (June 2025) and 10-Q (March 2025)
    expect(result.map((filing) => filing.form)).toEqual(['10-K', '10-Q']);
  });
});

describe('extractFilingText', () => {
  it('extracts text from HTML paragraphs', () => {
    const html = '<html><body><h1>Title</h1><p>Content here with details.</p></body></html>';
    const text = extractFilingText(html);
    expect(text).toContain('Title');
    expect(text).toContain('Content here with details.');
  });

  it('strips script and style tags', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><p>Real content is here.</p></body></html>';
    const text = extractFilingText(html);
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).toContain('Real content is here.');
  });

  it('skips parent elements that contain child paragraphs', () => {
    const html =
      '<html><body><div><p>Inner paragraph text here.</p></div><p>Standalone paragraph here.</p></body></html>';
    const text = extractFilingText(html);
    // Should contain the inner paragraph text, not duplicate from the div
    expect(text).toContain('Inner paragraph text here.');
    expect(text).toContain('Standalone paragraph here.');
  });

  it('truncates extremely long text', () => {
    const longParagraph = `<p>${'A'.repeat(200_000)}</p>`;
    const html = `<html><body>${longParagraph}</body></html>`;
    const text = extractFilingText(html);
    expect(text.length).toBeLessThanOrEqual(100_000 + 20); // +20 for [Truncated] suffix
    expect(text).toContain('[Truncated]');
  });

  it('holds the cursor when one ticker fails (others still return filings)', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('company_tickers.json')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(TICKER_MAP_RESPONSE) });
      }
      if (typeof url === 'string' && url.includes('data.sec.gov/submissions')) {
        // OTHER (cik 7654321) is down; TEST succeeds.
        return url.includes('7654321')
          ? Promise.resolve({ ok: false, status: 500 })
          : Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSIONS_RESPONSE) });
      }
      if (typeof url === 'string' && url.includes('/Archives/edgar/') && url.endsWith('.htm')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(FILING_HTML) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const cursor = { type: 'date', value: '2020-01-01T00:00:00.000Z' };
    const result = await sync(makeContext(cursor, { tickers: ['TEST', 'OTHER'] }));

    expect(result.documents.length).toBeGreaterThan(0);
    // The failed ticker's older filings must stay reachable next run.
    expect(result.cursor).toEqual(cursor);
  });

  it('reuses the cached ticker resolution for duplicate tickers', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST', 'test'] }));
    // Second occurrence resolves from cache; the run still succeeds and
    // documents are deduplicated by external id downstream.
    expect(result.documents.length).toBeGreaterThan(0);
  });
});
