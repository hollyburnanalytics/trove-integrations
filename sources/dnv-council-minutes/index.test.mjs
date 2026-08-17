import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, idSetCursor, makeSyncContext, okResponse, setFetch } from '../lib/feed-fixtures.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Stands in for `fetchPage` WITHOUT mocking the module. `mock.module` writes to
 * a process-global registry, and replacing `http.mjs` wholesale both dropped
 * its other exports and stubbed `fetchPage` for every OTHER suite — whose feeds
 * then all failed to parse an empty body. Mocking `fetch` keeps it local here.
 *
 * The `fetchPage`-shaped API is unchanged: configure with `.mockResolvedValue`
 * / `.mockRejectedValue`, assert with `.toHaveBeenCalled*` and `.mock.calls`.
 */
const fetchPage = vi.fn();

function installFetch() {
  setFetch(async (url) => okResponse(await fetchPage(String(url))));
}

const { sync } = await import('./index.mjs');

const makeContext = (overrides = {}) => makeSyncContext(overrides);

function meeting(overrides = {}) {
  return {
    date: '2026-02-10',
    type: 'Regular Meeting',
    subject: '',
    bylaw: '',
    meetingDocuments: [
      {
        text: 'Minutes',
        link: '/OpenDocument/Default.aspx?docNum=101',
        docName: 'RC.Minutes',
        docNumber: '101',
        docType: 'Minutes',
      },
    ],
    ...overrides,
  };
}

describe('dnv-council-minutes source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('maps a meeting document to a file_url document the server extracts', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    const document = at(result.documents);
    expect(document.id).toBe('dnv-council-101');
    expect(document.title).toBe('Minutes — Regular Meeting, 2026-02-10');
    expect(document.text).toBe('Minutes — Regular Meeting, 2026-02-10');
    expect(document.file_url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(document.mime_type).toBe('application/pdf');
    expect(document.url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(document.author).toBe('District of North Vancouver');
    // Noon in the District's own timezone, so the meeting renders on its own
    // calendar day locally rather than rolling back to the day before.
    //
    // February on purpose. Bun's bundled tzdata never applies the November 2026
    // fall-back — it reports America/Vancouver as PDT for every date from
    // ~2026-11-01 onward, where Node reports PST. A fixture dated in that window
    // asserts one offset under `bun test` and the other under Node, which reads
    // as a flaky test rather than as the runtime disagreement it is. Production
    // runs on workerd and is unaffected.
    expect(document.date).toBe('2026-02-10T20:00:00.000Z');
    expect(document.tags).toEqual(['Minutes', 'Regular Meeting']);
    expect(result.cursor).toEqual({ type: 'idSet', values: ['101'], max: 10_000 });
    expect(result.stats ?? {}).toEqual({ fetched: 1, remaining: 0 });
  });

  it('includes the subject and bylaw of a public hearing in the title and header', async () => {
    const hearing = meeting({
      type: 'Public Hearing',
      subject: '1565 Rupert Street',
      bylaw: 'Bylaw 8500',
    });
    fetchPage.mockResolvedValue(JSON.stringify([hearing]));

    const result = await sync(makeContext());

    expect(at(result.documents, 0).title).toBe(
      'Minutes — Public Hearing (1565 Rupert Street), 2026-02-10',
    );
    expect(at(result.documents, 0).text).toContain('Bylaw: Bylaw 8500');
  });

  it('skips video links and already-synced document numbers, oldest first', async () => {
    const older = meeting({
      date: '2026-01-06',
      meetingDocuments: [
        { docNumber: '50', docType: 'Agenda', text: 'Agenda' },
        { docNumber: '51', docType: 'Video', text: 'Video' },
      ],
    });
    fetchPage.mockResolvedValue(JSON.stringify([meeting(), older]));

    const result = await sync(makeContext({ cursor: { type: 'idSet', values: ['101'] } }));

    expect(result.documents.map((document) => document.id)).toEqual(['dnv-council-50']);
    expect(idSetCursor(result.cursor).values).toEqual(['101', '50']);
  });

  it('offers a bounded batch per run and reports the remainder', async () => {
    const big = meeting({
      meetingDocuments: Array.from({ length: 60 }, (_, index) => ({
        docNumber: String(1000 + index),
        docType: 'Minutes',
        text: 'Minutes',
      })),
    });
    fetchPage.mockResolvedValue(JSON.stringify([big]));

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(25);
    expect(result.stats ?? {}).toEqual({ fetched: 25, remaining: 35 });
    expect(idSetCursor(result.cursor).values).toHaveLength(25);

    // The next run resumes exactly after the offered batch.
    const next = await sync(makeContext({ cursor: result.cursor }));
    expect(at(next.documents, 0).id).toBe('dnv-council-1025');
    expect(next.stats ?? {}).toEqual({ fetched: 25, remaining: 10 });
  });

  it('keeps the prior cursor when nothing new is offered', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));
    const cursor = { type: 'idSet', values: ['101'] };

    const result = await sync(makeContext({ cursor }));

    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBe(cursor);
    expect(result.stats ?? {}).toEqual({ fetched: 0, remaining: 0 });
  });

  it('throws when the meeting index is unreachable', async () => {
    fetchPage.mockRejectedValue(new Error('HTTP 503 fetching index'));

    await expect(sync(makeContext())).rejects.toThrow('HTTP 503');
  });

  // --- the 2026 cutoff ---
  //
  // The District's API returns its whole archive back to 2011: 1,327 meetings
  // and 4,702 documents, of which 270 fall on or after 2026-01-01. Each one
  // costs a PDF download, a text extraction and a formatting pass, so the
  // boundary is worth asserting rather than assuming.

  it('SKIPS a meeting before the cutoff', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting({ date: '2025-12-31' })]));

    const result = await sync(makeContext());

    expect(result.documents).toEqual([]);
  });

  it('KEEPS a meeting on the cutoff day itself', async () => {
    // The boundary is inclusive, and it is compared as a `YYYY-MM-DD` string
    // rather than through `Date` — parsing a bare day gives midnight UTC, which
    // is the previous day on this coast, so a January 1st meeting would be
    // pushed to the wrong side of its own cutoff.
    fetchPage.mockResolvedValue(JSON.stringify([meeting({ date: '2026-01-01' })]));

    expect(await sync(makeContext())).toHaveProperty('documents.0.id', 'dnv-council-101');
  });

  it('drops an UNDATED meeting rather than assuming it is recent', async () => {
    // Every meeting the District returns carries a date today, so this decides
    // nothing now — it decides what happens if that stops being true.
    fetchPage.mockResolvedValue(JSON.stringify([meeting({ date: '' })]));

    const result = await sync(makeContext());
    expect(result.documents).toEqual([]);
  });

  it('counts only in-window documents as remaining, so the backfill looks finite', async () => {
    const old = meeting({
      date: '2019-05-01',
      meetingDocuments: [{ docNumber: '900', docType: 'Agenda', text: 'Agenda' }],
    });
    fetchPage.mockResolvedValue(JSON.stringify([meeting(), old]));

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    expect(result.stats?.remaining).toBe(0);
  });
});
