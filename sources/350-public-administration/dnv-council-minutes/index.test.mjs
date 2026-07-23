import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { sync } from './index.mjs';

function makeContext(overrides = {}) {
  return {
    log: { info: mock(), warn: mock() },
    progress: mock(),
    config: {},
    cursor: undefined,
    ...overrides,
  };
}

/** Build a minimal single-page PDF whose text layer is `text`. */
function minimalPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
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

/** Streamable Response-like object for the mocked fetch. */
function bytesResponse(bytes, headers = {}) {
  let delivered = false;
  return {
    ok: true,
    headers: { get: (name) => headers[name.toLowerCase()] },
    body: {
      getReader: () => ({
        read: () => {
          if (delivered) return Promise.resolve({ done: true });
          delivered = true;
          return Promise.resolve({ done: false, value: bytes });
        },
        cancel: () => {},
      }),
    },
  };
}

function jsonResponse(value) {
  return bytesResponse(new TextEncoder().encode(JSON.stringify(value)));
}

/** Mock fetch: first call returns the meeting index, then PDFs by docNum. */
function mockApi(meetings, pdfByNumber) {
  globalThis.fetch = mock((url) => {
    if (url.includes('councilsearch')) return Promise.resolve(jsonResponse(meetings));
    const number = new URL(url).searchParams.get('docNum');
    const pdf = pdfByNumber[number];
    if (!pdf) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve(typeof pdf === 'function' ? pdf() : bytesResponse(pdf));
  });
}

describe('dnv-council-minutes source', () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('maps a meeting document to a Trove document with extracted PDF text', async () => {
    mockApi([meeting()], { 101: minimalPdf('Council adopted the bylaw') });

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    const [document] = result.documents;
    expect(document.id).toBe('dnv-council-101');
    expect(document.title).toBe('Minutes — Regular Meeting, 2025-12-08');
    expect(document.text).toContain('Council adopted the bylaw');
    expect(document.url).toBe('https://app.dnv.org/OpenDocument/Default.aspx?docNum=101');
    expect(document.author).toBe('District of North Vancouver');
    expect(document.date).toBe('2025-12-08');
    expect(document.tags).toEqual(['Minutes', 'Regular Meeting']);
    expect(result.cursor).toEqual({ type: 'idSet', values: ['101'], max: 10_000 });
    expect(result.stats).toEqual({ fetched: 1, remaining: 0 });
  });

  it('includes the subject and bylaw of a public hearing', async () => {
    const hearing = meeting({
      type: 'Public Hearing',
      subject: '1565 Rupert Street',
      bylaw: 'Bylaw 8500',
    });
    mockApi([hearing], { 101: minimalPdf('Hearing text') });

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
    mockApi([meeting(), older], { 101: minimalPdf('Minutes'), 50: minimalPdf('Agenda') });

    const result = await sync(makeContext({ cursor: { type: 'idSet', values: ['101'] } }));

    expect(result.documents.map((document) => document.id)).toEqual(['dnv-council-50']);
    expect(result.cursor.values).toEqual(['101', '50']);
  });

  it('stops at the deadline and reports the remainder', async () => {
    const two = meeting({
      meetingDocuments: [
        { docNumber: '101', docType: 'Minutes', text: 'Minutes' },
        { docNumber: '102', docType: 'Agenda', text: 'Agenda' },
      ],
    });
    let calls = 0;
    mockApi([two], {
      101: () => {
        calls++;
        return bytesResponse(minimalPdf('First'));
      },
      102: () => {
        calls++;
        return bytesResponse(minimalPdf('Second'));
      },
    });

    // Deadline passes as soon as the first document has been processed.
    const context = makeContext({ deadline: Date.now() });
    const result = await sync(context);

    expect(calls).toBe(0);
    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBeUndefined();
    expect(result.stats.remaining).toBe(2);
  });

  it('stores a metadata-only document when the PDF exceeds the size cap', async () => {
    mockApi([meeting()], {
      101: () => bytesResponse(new Uint8Array(8), { 'content-length': String(64 * 1024 * 1024) }),
    });

    const context = makeContext();
    const result = await sync(context);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].text).toBe('Minutes — Regular Meeting, 2025-12-08');
    expect(result.cursor.values).toEqual(['101']); // permanent — never retried
    expect(context.log.warn).toHaveBeenCalled();
  });

  it('stores a metadata-only document when the PDF cannot be parsed', async () => {
    mockApi([meeting()], { 101: new TextEncoder().encode('not a pdf') });

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].text).toBe('Minutes — Regular Meeting, 2025-12-08');
    expect(result.cursor.values).toEqual(['101']);
  });

  it('leaves a transiently failed document unsynced so the next run retries it', async () => {
    mockApi([meeting()], {}); // document fetch 404s

    const context = makeContext();
    const result = await sync(context);

    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBeUndefined();
    expect(context.log.warn).toHaveBeenCalled();
  });

  it('throws when the meeting index is unreachable', async () => {
    globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 503 }));

    expect(sync(makeContext())).rejects.toThrow('HTTP 503');
  });
});
