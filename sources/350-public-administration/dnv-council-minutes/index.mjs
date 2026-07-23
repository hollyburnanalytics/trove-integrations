/**
 * District of North Vancouver council meetings — agendas, minutes, notices,
 * staff reports, and related documents from the District's council search API.
 * Each meeting document is a PDF, emitted as a `file_url` document: the ingest
 * pipeline downloads it, retains the original (rendered in the app), and
 * extracts its text into the body, with our `text` riding along as the header.
 *
 * Minutes are published to a meeting's record weeks after the meeting date, so
 * a date watermark would skip them; the cursor is instead an `idSet` of synced
 * document numbers. New documents are offered oldest-first in bounded batches,
 * so the 2011-to-present backfill converges across runs while the per-document
 * downloads stay paced.
 */

import { fetchPage } from '../../lib/http.mjs';
import { idSetWatermark, readIdSet } from '../../lib/watermark.mjs';

const SEARCH_URL = 'https://app.dnv.org/dnv_search/api/v1/councilsearch/search?pageSize=5000';
const DOCUMENT_URL = 'https://app.dnv.org/OpenDocument/Default.aspx?docNum=';
const AUTHOR = 'District of North Vancouver';

// Documents offered per sync round. Each becomes one server-side download, so
// this bounds how hard a round hits the District's document endpoint; the
// runner's round pacing spreads the ~4,700-document backfill over time.
const MAX_DOCUMENTS_PER_RUN = 25;

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
 * Build the Trove document for one meeting document: the PDF by URL, plus a
 * short metadata header (meeting, date, subject, bylaw) the extractor prepends
 * to the extracted text.
 *
 * @param {WorkItem} item
 */
function toDocument({ meeting, document }) {
  const title = `${document.docType} — ${meetingLabel(meeting)}, ${meeting.date}`;
  const header = [title, meeting.bylaw ? `Bylaw: ${meeting.bylaw}` : ''].filter(Boolean).join('\n');
  return {
    id: `dnv-council-${document.docNumber}`,
    title,
    text: header,
    file_url: `${DOCUMENT_URL}${document.docNumber}`,
    mime_type: 'application/pdf',
    url: `${DOCUMENT_URL}${document.docNumber}`,
    author: AUTHOR,
    date: meeting.date,
    tags: [document.docType, meeting.type],
  };
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
  const documents = batch.map((item) => toDocument(item));
  const syncedNumbers = batch.map((item) => item.document.docNumber);
  context.progress(documents.length, `${documents.length} documents`);

  const cursor =
    syncedNumbers.length > 0
      ? idSetWatermark([...previousNumbers, ...syncedNumbers])
      : context.cursor || undefined;
  return {
    documents,
    cursor,
    stats: {
      fetched: documents.length,
      remaining: pending.length - documents.length,
    },
  };
}
