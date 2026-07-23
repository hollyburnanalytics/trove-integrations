/**
 * District of North Vancouver council meetings — agendas, minutes, notices,
 * staff reports, and related documents from the District's council search API.
 * Each meeting document is a PDF. We download it, extract its text layer, and
 * emit BOTH: the text as the document body and the PDF as a `file_url` +
 * `capture_only` attachment, so the server retains the original (rendered in
 * the app) while indexing our extraction. Many older documents are Acrobat
 * web captures whose text survives a text-layer read but not a structural
 * conversion, so extracting here beats deferring to the server. A document too
 * large to extract in-process is sent without `capture_only`, deferring to the
 * server's extraction pipeline instead.
 *
 * Minutes are published to a meeting's record weeks after the meeting date, so
 * a date watermark would skip them; the cursor is instead an `idSet` of synced
 * document numbers. New documents are processed oldest-first in bounded,
 * deadline-aware batches, so the 2011-to-present backfill converges across
 * runs while requests stay paced.
 */

import { deadlineReached, sleep } from '../../lib/feeds.mjs';
import { fetchBytes, fetchPage, isTooLargeError } from '../../lib/http.mjs';
import { extractPdfText } from '../../lib/pdf.mjs';
import { idSetWatermark, readIdSet } from '../../lib/watermark.mjs';

const SEARCH_URL = 'https://app.dnv.org/dnv_search/api/v1/councilsearch/search?pageSize=5000';
const DOCUMENT_URL = 'https://app.dnv.org/OpenDocument/Default.aspx?docNum=';
const AUTHOR = 'District of North Vancouver';

// In-process extraction cap. PDF text extraction costs roughly 15-20x the file
// size in memory, so this bounds peak sync memory; a larger document is sent
// without a body and the server's extraction pipeline (with its own, higher
// cap) takes over.
const MAX_PDF_BYTES = 8 * 1024 * 1024;

// Documents processed per sync round — bounds both this run's downloads and
// the server-side downloads the emitted documents trigger.
const MAX_DOCUMENTS_PER_RUN = 25;

// Pause between document downloads.
const DELAY_MS = 1000;

/**
 * @typedef {{ text: string, link: string, docName: string, docNumber: string,
 *   docType: string }} MeetingDocument
 * @typedef {{ date: string, type: string, subject: string, bylaw: string,
 *   meetingDocuments: MeetingDocument[] }} Meeting
 * @typedef {{ meeting: Meeting, document: MeetingDocument }} WorkItem
 */

/**
 * Flatten the meeting index into per-document work items: video links (external,
 * not documents) and already-synced document numbers are dropped, and the rest
 * are ordered oldest-first so the backfill advances chronologically.
 *
 * @param {Meeting[]} meetings
 * @param {Set<string>} seenNumbers
 * @returns {WorkItem[]}
 */
function pendingDocuments(meetings, seenNumbers) {
  const items = [];
  const queued = new Set();
  for (const meeting of meetings) {
    for (const document of meeting.meetingDocuments ?? []) {
      const { docNumber, docType } = document;
      if (!docNumber || docType === 'Video') continue;
      if (seenNumbers.has(docNumber) || queued.has(docNumber)) continue;
      queued.add(docNumber);
      items.push({ meeting, document });
    }
  }
  return items.toSorted((a, b) => a.meeting.date.localeCompare(b.meeting.date));
}

/** "Regular Meeting" or "Public Hearing (1565 Rupert Street)" */
function meetingLabel(meeting) {
  return meeting.subject ? `${meeting.type} (${meeting.subject})` : meeting.type;
}

/**
 * Build the Trove document for one meeting document. With an extracted `body`,
 * the text (header + body) is indexed as-is and `capture_only` tells the
 * server to just retain the PDF; without one, the server's extraction pipeline
 * downloads, retains, and extracts instead (our text riding along as the
 * header).
 *
 * @param {WorkItem} item
 * @param {string | undefined} body - extracted PDF text, or undefined to defer
 *   extraction to the server
 */
function toDocument({ meeting, document }, body) {
  const title = `${document.docType} — ${meetingLabel(meeting)}, ${meeting.date}`;
  const header = [title, meeting.bylaw ? `Bylaw: ${meeting.bylaw}` : ''].filter(Boolean).join('\n');
  return {
    id: `dnv-council-${document.docNumber}`,
    title,
    text: body ? `${header}\n\n${body}` : header,
    file_url: `${DOCUMENT_URL}${document.docNumber}`,
    mime_type: 'application/pdf',
    ...(body && { capture_only: true }),
    url: `${DOCUMENT_URL}${document.docNumber}`,
    author: AUTHOR,
    date: meeting.date,
    tags: [document.docType, meeting.type],
  };
}

/**
 * Download one document and extract its text. Returns the extracted body, or
 * `undefined` for permanent conditions (over the size cap, unparseable, or an
 * empty text layer) where the server-side extraction pipeline is the better
 * home for the work. Transient failures (network, HTTP errors) propagate so
 * the caller can retry the document next run.
 *
 * @param {object} context
 * @param {WorkItem} item
 * @returns {Promise<string | undefined>}
 */
async function extractDocumentBody(context, item) {
  const url = `${DOCUMENT_URL}${item.document.docNumber}`;
  let bytes;
  try {
    bytes = await fetchBytes(url, { maxBytes: MAX_PDF_BYTES });
  } catch (error) {
    if (!isTooLargeError(error)) throw error;
    context.log.info(`Deferring oversized document to server extraction: ${url}`);
    return;
  }
  try {
    const text = await extractPdfText(bytes);
    return text.length > 0 ? text : undefined;
  } catch (error) {
    context.log.warn(`Deferring unreadable PDF to server extraction ${url}: ${error.message}`);
    return;
  }
}

export async function sync(context) {
  context.log.info('Fetching council meeting index...');
  /** @type {Meeting[]} */
  const meetings = JSON.parse(await fetchPage(SEARCH_URL));
  const previousNumbers = readIdSet(context.cursor);
  const pending = pendingDocuments(meetings, new Set(previousNumbers));
  context.log.info(
    `${meetings.length} meetings, ${pending.length} new documents (${previousNumbers.length} already synced)`,
  );

  const batch = pending.slice(0, MAX_DOCUMENTS_PER_RUN);
  const documents = [];
  const syncedNumbers = [];
  for (const [index, item] of batch.entries()) {
    if (deadlineReached(context)) {
      context.log.info('Time budget reached — resuming next run');
      break;
    }
    let body;
    try {
      body = await extractDocumentBody(context, item);
    } catch (error) {
      context.log.warn(`Failed to fetch document ${item.document.docNumber}: ${error.message}`);
      continue; // not marked synced — retried next run
    }
    documents.push(toDocument(item, body));
    syncedNumbers.push(item.document.docNumber);
    context.progress(documents.length, `${documents.length} documents`);
    if (index < batch.length - 1) await sleep(DELAY_MS);
  }

  const cursor =
    syncedNumbers.length > 0
      ? idSetWatermark([...previousNumbers, ...syncedNumbers])
      : context.cursor || undefined;
  return {
    documents,
    cursor,
    stats: {
      fetched: documents.length,
      // Everything still pending after this run — unprocessed batch items
      // (deadline, transient failures) and the un-batched tail alike.
      remaining: pending.length - syncedNumbers.length,
    },
  };
}
