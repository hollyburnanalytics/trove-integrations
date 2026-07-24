import { afterAll, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

afterAll(() => mock.restore());

const fetchPage = mock();

mock.module('../../lib/http.mjs', () => ({ fetchPage }));

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

describe('dnv-council-minutes source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps a meeting document to a file_url document the server extracts', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    const [document] = result.documents;
    expect(document.id).toBe('dnv-council-101');
    expect(document.title).toBe('Minutes — Regular Meeting, 2025-12-08');
    expect(document.text).toBe('Minutes — Regular Meeting, 2025-12-08');
    expect(document.file_url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(document.mime_type).toBe('application/pdf');
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
    expect(result.stats).toEqual({ fetched: 25, remaining: 35 });
    expect(result.cursor.values).toHaveLength(25);

    // The next run resumes exactly after the offered batch.
    const next = await sync(makeContext({ cursor: result.cursor }));
    expect(next.documents[0].id).toBe('dnv-council-1025');
    expect(next.stats).toEqual({ fetched: 25, remaining: 10 });
  });

  it('keeps the prior cursor when nothing new is offered', async () => {
    fetchPage.mockResolvedValue(JSON.stringify([meeting()]));
    const cursor = { type: 'idSet', values: ['101'] };

    const result = await sync(makeContext({ cursor }));

    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBe(cursor);
    expect(result.stats).toEqual({ fetched: 0, remaining: 0 });
  });

  it('throws when the meeting index is unreachable', async () => {
    fetchPage.mockRejectedValue(new Error('HTTP 503 fetching index'));

    expect(sync(makeContext())).rejects.toThrow('HTTP 503');
  });
});
