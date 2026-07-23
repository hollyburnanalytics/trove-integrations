import { afterAll, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

const fetchPage = mock();
const fetchBytes = mock();
const deadlineReached = mock(() => false);
const extractPdfText = mock();

mock.module('../../lib/http.mjs', () => ({
  fetchPage,
  fetchBytes,
  // Mirrors the real contract: cap rejections carry this code.
  isTooLargeError: (error) => error?.code === 'ERESPONSETOOLARGE',
}));
mock.module('../../lib/feeds.mjs', () => ({
  deadlineReached,
  sleep: () => Promise.resolve(),
}));
mock.module('../../lib/pdf.mjs', () => ({ extractPdfText }));

const { sync } = await import('./index.mjs');

function makeContext(overrides = {}) {
  return {
    log: { info: jest.fn(), warn: jest.fn() },
    progress: jest.fn(),
    config: {},
    cursor: undefined,
    ...overrides,
  };
}

function meeting(overrides = {}) {
  return {
    date: '2025-12-08',
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

function tooLargeError() {
  return Object.assign(new Error('Response too large (67108864 bytes)'), {
    code: 'ERESPONSETOOLARGE',
  });
}

describe('dnv-council-minutes source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deadlineReached.mockReturnValue(false);
    fetchBytes.mockResolvedValue(new Uint8Array([1]));
    extractPdfText.mockResolvedValue('Council adopted the bylaw');
  });

  it('emits an extracted body with the PDF as a capture-only attachment', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    const [document] = result.documents;
    expect(document.id).toBe('dnv-council-101');
    expect(document.title).toBe('Minutes — Regular Meeting, 2025-12-08');
    expect(document.text).toBe(
      'Minutes — Regular Meeting, 2025-12-08\n\nCouncil adopted the bylaw',
    );
    expect(document.file_url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(document.mime_type).toBe('application/pdf');
    expect(document.capture_only).toBe(true);
    expect(document.url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(document.author).toBe('District of North Vancouver');
    expect(document.date).toBe('2025-12-08');
    expect(document.tags).toEqual(['Minutes', 'Regular Meeting']);
    expect(result.cursor).toEqual({ type: 'idSet', values: ['101'], max: 10_000 });
    expect(result.stats).toEqual({ fetched: 1, remaining: 0 });
  });

  it('includes the subject and bylaw of a public hearing in the title and header', async () => {
    const hearing = meeting({
      type: 'Public Hearing',
      subject: '1565 Rupert Street',
      bylaw: 'Bylaw 8500',
    });
    fetchPage.mockResolvedValue(JSON.stringify([hearing]));

    const result = await sync(makeContext());

    expect(result.documents[0].title).toBe(
      'Minutes — Public Hearing (1565 Rupert Street), 2025-12-08',
    );
    expect(result.documents[0].text).toContain('Bylaw: Bylaw 8500');
  });

  it('defers an oversized document to server extraction (no body, no capture_only)', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));
    fetchBytes.mockRejectedValue(tooLargeError());

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    const [document] = result.documents;
    expect(document.text).toBe('Minutes — Regular Meeting, 2025-12-08'); // header only
    expect(document.capture_only).toBeUndefined();
    expect(document.file_url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(result.cursor.values).toEqual(['101']);
  });

  it('defers an unreadable or empty-text PDF to server extraction', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));
    extractPdfText.mockRejectedValueOnce(new Error('bad pdf'));

    const unreadable = await sync(makeContext());
    expect(unreadable.documents[0].capture_only).toBeUndefined();

    extractPdfText.mockResolvedValueOnce('');
    const empty = await sync(makeContext());
    expect(empty.documents[0].capture_only).toBeUndefined();
  });

  it('skips video links and already-synced document numbers, oldest first', async () => {
    const older = meeting({
      date: '2025-01-06',
      meetingDocuments: [
        { docNumber: '50', docType: 'Agenda', text: 'Agenda' },
        { docNumber: '51', docType: 'Video', text: 'Video' },
      ],
    });
    fetchPage.mockResolvedValue(JSON.stringify([meeting(), older]));

    const result = await sync(makeContext({ cursor: { type: 'idSet', values: ['101'] } }));

    expect(result.documents.map((document) => document.id)).toEqual(['dnv-council-50']);
    expect(result.cursor.values).toEqual(['101', '50']);
  });

  it('bounds each run to the batch cap and reports the remainder', async () => {
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
    expect(result.stats).toEqual({ fetched: 25, remaining: 35 });
  });

  it('stops at the deadline without consuming the rest of the batch', async () => {
    const two = meeting({
      meetingDocuments: [
        { docNumber: '101', docType: 'Minutes', text: 'Minutes' },
        { docNumber: '102', docType: 'Agenda', text: 'Agenda' },
      ],
    });
    fetchPage.mockResolvedValue(JSON.stringify([two]));
    deadlineReached.mockReturnValue(true);

    const result = await sync(makeContext());

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBeUndefined();
    expect(result.stats.remaining).toBe(2);
  });

  it('leaves a transiently failed document unsynced so the next run retries it', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));
    fetchBytes.mockRejectedValue(new Error('HTTP 404 fetching document'));

    const context = makeContext();
    const result = await sync(context);

    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBeUndefined();
    expect(result.stats.remaining).toBe(1);
    expect(context.log.warn).toHaveBeenCalled();
  });

  it('throws when the meeting index is unreachable', async () => {
    fetchPage.mockRejectedValue(new Error('HTTP 503 fetching index'));

    expect(sync(makeContext())).rejects.toThrow('HTTP 503');
  });
});
