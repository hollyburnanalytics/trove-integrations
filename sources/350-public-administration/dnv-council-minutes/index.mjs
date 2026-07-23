/**
 * District of North Vancouver council meetings — agendas, minutes, notices,
 * staff reports, and related documents from the District's council search API.
 * Each meeting document is a PDF; we download it, extract its text layer, and
 * store it as one Trove document.
 *
 * Minutes are published to a meeting's record weeks after the meeting date, so
 * a date watermark would skip them; the cursor is instead an `idSet` of synced
 * document numbers. New documents are processed oldest-first under the host's
 * soft deadline, so the 2011-to-present backfill converges across runs.
 */

import { deadlineReached } from '../../lib/feeds.mjs';
import { fetchBytes, fetchPage, isTooLargeError } from '../../lib/http.mjs';
import { extractPdfText } from '../../lib/pdf.mjs';
import { idSetWatermark, readIdSet } from '../../lib/watermark.mjs';

const SEARCH_URL = 'https://app.dnv.org/dnv_search/api/v1/councilsearch/search?pageSize=5000';
const DOCUMENT_URL = 'https://app.dnv.org/OpenDocument/Default.aspx?docNum=';
const AUTHOR = 'District of North Vancouver';

// Documents above this cap are stored as metadata-only entries linking to the
// original (the cap rejects on the Content-Length header, before download).
// Sampled sizes: minutes/agendas/notices/presentations all fit well under
// 8 MB; only the largest agenda-with-reports packages (up to ~50 MB) exceed
// it. The binding constraint is memory, not bandwidth: PDF text extraction
// costs roughly 15-20x the file size, so this cap bounds peak sync memory.
const MAX_PDF_BYTES = 8 * 1024 * 1024;

// Pause between document downloads.
const DELAY_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Build the Trove document for one meeting document: a short metadata header
 * (meeting, date, subject, bylaw) followed by the PDF's extracted text. An
 * empty body (an image-only scan, or a document we could not download) still
 * yields a searchable entry that links to the original.
 *
 * @param {WorkItem} item
 * @param {string} body - extracted PDF text ('' when unavailable)
 */
function toDocument({ meeting, document }, body) {
  const header = [
    `${document.docType} — ${meetingLabel(meeting)}, ${meeting.date}`,
    meeting.bylaw ? `Bylaw: ${meeting.bylaw}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: `dnv-council-${document.docNumber}`,
    title: `${document.docType} — ${meetingLabel(meeting)}, ${meeting.date}`,
    text: [header, body].filter(Boolean).join('\n\n'),
    url: `${DOCUMENT_URL}${document.docNumber}`,
    author: AUTHOR,
    date: meeting.date,
    tags: [document.docType, meeting.type],
  };
}

/**
 * Download one document and extract its text. Returns the extracted body, or
 * '' for permanent conditions (over the size cap, unparseable PDF) where a
 * metadata-only entry is the best we can store. Transient failures (network,
 * HTTP errors) propagate so the caller can retry the document next run.
 *
 * @param {object} context
 * @param {WorkItem} item
 * @returns {Promise<string>}
 */
async function fetchDocumentBody(context, item) {
  const url = `${DOCUMENT_URL}${item.document.docNumber}`;
  let bytes;
  try {
    bytes = await fetchBytes(url, { maxBytes: MAX_PDF_BYTES });
  } catch (error) {
    if (!isTooLargeError(error)) throw error;
    context.log.warn(`Storing metadata only for oversized document ${url}: ${error.message}`);
    return '';
  }
  try {
    return await extractPdfText(bytes);
  } catch (error) {
    context.log.warn(`Storing metadata only for unreadable PDF ${url}: ${error.message}`);
    return '';
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

  const documents = [];
  const syncedNumbers = [];
  let stoppedEarly = false;
  for (const [index, item] of pending.entries()) {
    if (deadlineReached(context)) {
      context.log.info('Time budget reached — resuming next run');
      stoppedEarly = true;
      break;
    }
    let body;
    try {
      body = await fetchDocumentBody(context, item);
    } catch (error) {
      context.log.warn(`Failed to fetch document ${item.document.docNumber}: ${error.message}`);
      continue; // not marked synced — retried next run
    }
    documents.push(toDocument(item, body));
    syncedNumbers.push(item.document.docNumber);
    context.progress(documents.length, `${documents.length} documents`);
    if (index < pending.length - 1) await sleep(DELAY_MS);
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
      remaining: stoppedEarly ? pending.length - documents.length : 0,
    },
  };
}
