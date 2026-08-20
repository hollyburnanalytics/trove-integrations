/**
 * District of North Vancouver council meetings — agendas, minutes, notices,
 * staff reports, and related documents from the District's council search API.
 * Each meeting document is a PDF, emitted as a `fileUrl` document: the ingest
 * pipeline downloads it, retains the original (rendered in the app), and
 * extracts its text into the body, with our `text` riding along as the header.
 *
 * Minutes are published to a meeting's record weeks after the meeting date, so
 * a date cursor would skip them; the cursor is instead an `idSet` of synced
 * document numbers. New documents are offered oldest-first in bounded batches,
 * so the backfill converges across runs while the per-document downloads stay
 * paced.
 *
 * The District's API returns its whole archive back to 2011 — 1,327 meetings and
 * 4,702 documents. Only meetings from {@link EARLIEST_MEETING_DAY} onward are
 * synced (270 documents), because the older record is a research archive rather
 * than something a reader is following, and every document in it costs a PDF
 * download, a text extraction and a formatting pass.
 */

import { defineSource, fetchPage, idSetCursor, readIdSet } from '@ontrove/extend/source';
import { dayToLocalNoonIso } from '../lib/text.mjs';

const SEARCH_URL = 'https://app.dnv.org/dnv_search/api/v1/councilsearch/search?pageSize=5000';
const DOCUMENT_URL = 'https://app.dnv.org/OpenDocument/Default.aspx?docNum=';
const AUTHOR = 'District of North Vancouver';
/** The District's own timezone — meeting days are local calendar days. */
const MEETING_TIME_ZONE = 'America/Vancouver';

// Documents offered per sync round. Each becomes one server-side download, so
// this bounds how hard a round hits the District's document endpoint; the
// runner's round pacing spreads the ~4,700-document backfill over time.
const MAX_DOCUMENTS_PER_RUN = 25;

/**
 * The earliest meeting day to sync, as the `YYYY-MM-DD` the API itself uses.
 *
 * Compared as a string on purpose: the API's `date` is a bare calendar day in
 * that exact format, and ISO day strings sort correctly lexicographically. Going
 * through `Date` here would reintroduce the timezone bug that `dayToLocalNoonIso`
 * exists to fix — a bare day parses as midnight UTC, which is the *previous* day
 * on this coast, so a January 1st meeting would fall on the wrong side of its own
 * cutoff.
 */
const EARLIEST_MEETING_DAY = '2026-01-01';

/**
 * @typedef {{ text: string, link: string, docName: string, docNumber: string,
 *   docType: string }} MeetingDocument
 * @typedef {{ date: string, type: string, subject: string, bylaw: string,
 *   meetingDocuments: MeetingDocument[] }} Meeting
 * @typedef {{ meeting: Meeting, document: MeetingDocument }} WorkItem
 */

/**
 * The documents one meeting still owes, skipping videos and anything already
 * stored or already queued by an earlier meeting that listed the same paper.
 *
 * @param {Meeting} meeting - The meeting to read.
 * @param {Set<string>} seenNumbers - Document numbers already synced.
 * @param {Set<string>} queued - Numbers this run has already queued, mutated here.
 * @returns {WorkItem[]} Its pending documents.
 */
function pendingForMeeting(meeting, seenNumbers, queued) {
  /** @type {WorkItem[]} */
  const items = [];
  const meetingDocuments = meeting.meetingDocuments ?? [];
  for (const document of meetingDocuments) {
    const { docNumber, docType } = document;
    // A video is a link, not a document, and a number already stored (or
    // already queued by an earlier meeting that listed the same paper) is not
    // work.
    if (!docNumber || docType === 'Video') continue;
    if (seenNumbers.has(docNumber) || queued.has(docNumber)) continue;
    queued.add(docNumber);
    items.push({ meeting, document });
  }
  return items;
}

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
    // A meeting with no date is dropped rather than kept. Every one of the
    // District's 1,327 meetings carries a date today, so this decides nothing
    // now; it decides what happens if that ever stops being true, and an
    // undated meeting cannot be shown to fall inside the window.
    if (!meeting.date || meeting.date < EARLIEST_MEETING_DAY) continue;
    items.push(...pendingForMeeting(meeting, seenNumbers, queued));
  }
  return items.toSorted((a, b) => a.meeting.date.localeCompare(b.meeting.date));
}

/**
 * "Regular Meeting" or "Public Hearing (1565 Rupert Street)".
 *
 * @param {Meeting} meeting - The meeting to name.
 * @returns {string} Its label.
 */
function meetingLabel(meeting) {
  return meeting.subject ? `${meeting.type} (${meeting.subject})` : meeting.type;
}

/**
 * Build the Trove document for one meeting document: the PDF by URL, plus a
 * short metadata header (meeting, date, subject, bylaw) the extractor prepends
 * to the extracted text.
 *
 * @param {WorkItem} item - One meeting document to emit.
 * @returns {import('../lib/types.d.ts').TroveDocument} The document.
 */
function toDocument({ meeting, document }) {
  const title = `${document.docType} — ${meetingLabel(meeting)}, ${meeting.date}`;
  const header = [title, meeting.bylaw ? `Bylaw: ${meeting.bylaw}` : ''].filter(Boolean).join('\n');
  return {
    id: `dnv-council-${document.docNumber}`,
    title,
    text: header,
    fileUrl: `${DOCUMENT_URL}${document.docNumber}`,
    mimeType: 'application/pdf',
    url: `${DOCUMENT_URL}${document.docNumber}`,
    author: AUTHOR,
    // The API gives a bare meeting day (`YYYY-MM-DD`). Anchor it to noon in
    // the District's own timezone: left bare it parses as midnight UTC, which
    // renders as the *previous* day here on the coast.
    date: dayToLocalNoonIso(meeting.date, MEETING_TIME_ZONE),
    tags: [document.docType, meeting.type],
  };
}

export default defineSource({
  id: 'dnv-council-minutes',
  name: 'DNV Council Meetings',
  description:
    'Agendas, minutes, and reports from District of North Vancouver council meetings — the public record of local government decisions (2026 onwards)',
  icon: '🏛️',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'idSet',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'daily',
  status: 'implemented',
  needsBrowser: false,
  egress: ['app.dnv.org'],
  egressNote: 'The council search API and the meeting PDFs it points at are both on app.dnv.org.',
  formatting: 'reformat',
  async sync(context) {
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
        ? idSetCursor([...previousNumbers, ...syncedNumbers])
        : context.cursor || undefined;
    return {
      documents,
      cursor,
      stats: {
        fetched: documents.length,
        remaining: pending.length - documents.length,
      },
    };
  },
});
