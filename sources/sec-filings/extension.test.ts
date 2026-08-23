import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  at,
  dateCursorValue,
  fetchMock,
  makeSourceContext,
  setFetch,
  syncOf,
} from '../lib/test-fixtures.ts';
import type { ConfigValue, Cursor, SourceContext } from '../lib/types.js';
import extension from './extension.ts';
import type { Filing } from './filing-document.ts';
import { filterFilings } from './filing-document.ts';

const sync = syncOf(extension);

/**
 * A real `Response`, because the adapter fetches through the shared
 * `fetchPage` — which streams the body and reads headers, so a bare
 * `{ ok, json }` object no longer models what comes back.
 */
/**
 * @param payload - What the endpoint returns.
 * @returns The response.
 */
function jsonResponse(payload: unknown): Promise<Response> {
  return Promise.resolve(Response.json(payload));
}

/**
 * A real text `Response`.
 *
 * @param body - The body.
 * @param status - The status code.
 * @returns The response.
 */
function textResponse(body: string, status: number = 200): Promise<Response> {
  return Promise.resolve(new Response(body, { status }));
}

/**
 * A context for this source.
 *
 * @param cursor - The previous run's cursor.
 * @param config - Source config.
 * @returns The context.
 */
const makeContext = (cursor?: Cursor, config: Record<string, ConfigValue> = {}): SourceContext =>
  makeSourceContext({ config, cursor });

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
  fetchMock().mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('company_tickers.json')) {
      return jsonResponse(TICKER_MAP_RESPONSE);
    }
    if (typeof url === 'string' && url.includes('data.sec.gov/submissions')) {
      return jsonResponse(submissions);
    }
    if (typeof url === 'string' && url.includes('/Archives/edgar/') && url.endsWith('.htm')) {
      return textResponse(html);
    }
    return textResponse('', 404);
  });
}

describe('sec-filings source', () => {
  beforeEach(() => {
    setFetch();
  });

  afterEach(() => vi.restoreAllMocks());

  it('warns when no tickers configured', async () => {
    const context = makeContext(undefined, {});
    const result = await sync(context);
    expect(context.log.warn).toHaveBeenCalledWith('No tickers configured');
    expect(result.documents).toEqual([]);
    expect(result.stats?.fetched).toBe(0);
  });

  it('fetches filings for a ticker', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));

    // Should have 3 filings (2x 10-Q + 1x 10-K, form "4" is excluded)
    expect(result.documents).toHaveLength(3);
    expect(result.stats?.fetched).toBe(3);
    expect(at(result.documents, 0).title).toContain('Test Corp');
    expect(at(result.documents, 0).title).toContain('10-Q');
    expect(at(result.documents, 0).tags).toContain('10-Q');
    expect(at(result.documents, 0).tags).toContain('TEST');
  });

  it('builds the document URL from the API primary document', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    expect(at(result.documents, 0).url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1234567/000123456725000001/test-20250930.htm',
    );
  });

  it('uses cursor to skip old filings', async () => {
    mockFetchForSync();

    // Set cursor to 2025-01-01 — should skip the 2024-03-01 10-K
    const cursor: Cursor = { type: 'date', value: '2025-01-01T00:00:00.000Z' };
    const result = await sync(makeContext(cursor, { tickers: ['TEST'] }));

    expect(result.documents).toHaveLength(2);
    expect(result.stats?.skipped).toBe(1);
    // Only the two 2025 10-Q filings
    expect(result.documents.every((document) => (document.tags ?? []).includes('10-Q'))).toBe(true);
  });

  it('advances cursor to max filing date', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));

    expect(result.cursor).toBeTruthy();
    expect(dateCursorValue(result.cursor)).toBe(new Date('2025-11-15').toISOString());
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
    fetchMock().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('company_tickers.json')) {
        return jsonResponse(TICKER_MAP_RESPONSE);
      }
      if (typeof url === 'string' && url.includes('data.sec.gov/submissions')) {
        return textResponse('', 500);
      }
      return textResponse('', 404);
    });

    const context = makeContext(undefined, { tickers: ['TEST'] });
    const result = await sync(context);

    expect(context.log.warn).toHaveBeenCalled();
    expect(result.documents).toEqual([]);
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

    expect(at(result1.documents, 0).id).toBe(at(result2.documents, 0).id);
    expect(at(result1.documents, 0).id).toMatch(/^sec-/);
  });

  it('includes filing metadata in document text', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    const document = at(result.documents);

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
    expect(at(result.documents, 0).author).toBe('TEST CORP');
  });

  it('anchors the bare filing day to noon Eastern, not midnight UTC', async () => {
    mockFetchForSync({
      submissions: {
        name: 'Test Corp',
        filings: {
          recent: {
            accessionNumber: ['0001234567-25-000001'],
            filingDate: ['2025-11-15'],
            reportDate: [''],
            form: ['10-K'],
            primaryDocument: ['test-20241231.htm'],
          },
        },
      },
    });

    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));

    // Midnight UTC would render as 2025-11-14 anywhere in North America.
    expect(at(result.documents, 0).date).toBe('2025-11-15T17:00:00.000Z');
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
    // An unparseable filing date leaves `date` unset rather than substituting
    // the sync time — the server still records its own ingestion date.
    expect(at(result.documents, 0).date).toBeUndefined();
  });

  it('normalizes ticker to uppercase', async () => {
    mockFetchForSync();

    const result = await sync(makeContext(undefined, { tickers: ['test'] }));
    expect(result.documents.length).toBeGreaterThan(0);
    expect(at(result.documents, 0).tags).toContain('TEST');
  });
});

/**
 * One filing, with the fields `filterFilings` reads and the rest left blank —
 * `fetchFilings` zips every column, so a real filing always carries them.
 *
 * @param accessionNumber - Its accession number.
 * @param filingDate - The day it was filed.
 * @param form - Its form type.
 * @returns The filing.
 */
const filing = (accessionNumber: string, filingDate: string, form: string): Filing => ({
  accessionNumber,
  filingDate,
  form,
  reportDate: '',
  primaryDocument: '',
});

describe('filterFilings', () => {
  const filings = [
    filing('001', '2025-06-01', '10-K'),
    filing('002', '2025-03-01', '10-Q'),
    filing('003', '2025-01-01', '4'),
    filing('004', '2024-06-01', 'S-1'),
    filing('005', '2024-01-01', '10-K'),
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

/**
 * The shipped extractor emitted every passage two or three times. Measured on a
 * real Shopify 10-K/A: 503 paragraphs of which 250 were distinct, one repeated
 * twelve times, 42% of stored words redundant — and because the output hit the
 * 100,000-character cap exactly, the duplicates pushed real content OUT of every
 * long filing. These hold the shape that caused it.
 */

/**
 * The filing is handed over, not flattened here. Extraction in the adapter threw
 * away the headings and tables the platform turns into Markdown, capped every
 * document at 100,000 characters (a 10-K stopped mid-Part-II), kept no
 * retrievable copy, and spent an EDGAR request per filing on work the server
 * does anyway.
 */
describe('sec-filings hands over the filing as an artifact', () => {
  beforeEach(() => {
    setFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it('carries the filing as an HTML artifact', async () => {
    mockFetchForSync();
    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    const document = at(result.documents);
    expect(document.fileUrl).toContain('/Archives/edgar/data/');
    expect(document.mimeType).toBe('text/html');
  });

  it('carries only the header as text, leaving the body to extraction', async () => {
    mockFetchForSync();
    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    const document = at(result.documents);
    expect(document.text).toContain('Test Corp');
    expect(document.text).toContain('Filed:');
    // The body arrives from the artifact. Storing a flattened copy here would
    // be the header and the body disagreeing about the same filing.
    expect(String(document.text).length).toBeLessThan(200);
  });

  it('no longer fetches each filing document itself', async () => {
    mockFetchForSync();
    await sync(makeContext(undefined, { tickers: ['TEST'] }));
    const filingFetches = fetchMock().mock.calls.filter(([url]) =>
      String(url).includes('/Archives/edgar/'),
    );
    // EDGAR answers a generic client with 403 and throttles hard, so a request
    // the server is going to make anyway is worth not making twice.
    expect(filingFetches).toHaveLength(0);
  });

  it('still skips a filing with no HTML primary document', async () => {
    mockFetchForSync({
      submissions: {
        name: 'Test Corp',
        filings: {
          recent: {
            accessionNumber: ['0001234567-25-000001'],
            filingDate: ['2025-11-15'],
            reportDate: ['2025-09-30'],
            form: ['10-K'],
            primaryDocument: ['test.txt'],
          },
        },
      },
    });
    const result = await sync(makeContext(undefined, { tickers: ['TEST'] }));
    expect(result.documents).toHaveLength(0);
  });
});
