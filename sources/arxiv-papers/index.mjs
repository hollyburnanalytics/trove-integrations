import { stringList } from '../lib/constants.mjs';
import { deadlineReached, decodeHtmlEntities, fetchPage, safeDate } from '../lib/feeds.mjs';
import { advanceDateWatermark, readDateWatermark } from '../lib/watermark.mjs';

/** Results per arXiv API page. */
export const PAGE_SIZE = 100;
/**
 * Page cap per query per run. Bounds a cold backfill (no watermark yet) to
 * PAGE_SIZE * MAX_PAGES_PER_QUERY papers; the watermark carries on from there
 * on later runs, so nothing is lost — just spread across runs.
 */
const MAX_PAGES_PER_QUERY = 5;

/**
 * One Atom element's text content, or `''`.
 *
 * @type {(xml: string, tag: string) => string}
 */
const getTagValue = (xml, tag) => {
  const [, value] = xml.match(new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`)) ?? [];
  return value ? value.trim() : '';
};

/**
 * @typedef {{ documentId: string, publishedMs: number,
 *   doc: import('../lib/types.d.ts').TroveDocument }} PaperEntry
 * @typedef {{ lastDate: Date | undefined, seenIds: Set<string>,
 *   documents: import('../lib/types.d.ts').TroveDocument[],
 *   publishedTimes: number[] }} Accumulators
 */

/**
 * Project one `<entry>` onto a document, plus what the caller needs to decide
 * whether to keep it.
 *
 * @param {string} entryXml - The entry's markup.
 * @returns {PaperEntry} The document and its identity and publication time.
 */
function entryToDocument(entryXml) {
  const get = getTagValue.bind(undefined, entryXml);
  const id = get('id');
  // arXiv's Atom payload entity-encodes titles/abstracts (H&amp;E, &lt;) —
  // decode so stored text is GFM-clean.
  const title = decodeHtmlEntities(get('title').replaceAll(/\s+/g, ' '));
  const summary = decodeHtmlEntities(get('summary').replaceAll(/\s+/g, ' '));
  const published = get('published');
  const authors = [
    ...entryXml.matchAll(/<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g),
  ].map(([, name = '']) => name.trim());

  const paperId = id.split('/').at(-1) ?? '';

  return {
    documentId: `arxiv-${paperId}`,
    publishedMs: published ? new Date(published).getTime() : Number.NaN,
    doc: {
      id: `arxiv-${paperId}`,
      title,
      // Rides along as the extraction header — the abstract stays readable even
      // before the body is extracted, and remains the whole body for a paper
      // neither rendering covers.
      text: `${title}\n\n${summary}`,
      // The paper itself, not just its abstract. HTML first and PDF second is
      // not a preference about file formats: arXiv's LaTeXML HTML carries every
      // formula's LaTeX in `alttext`, which the server's `to-text` turns into
      // readable `$…$`. The same equation out of a PDF is glyph soup, and a
      // two-column layout welds paragraphs together. For a paper the maths IS
      // most of the meaning, so the better rendering is worth preferring and
      // the PDF is worth keeping for the papers that predate it.
      file_url: `https://arxiv.org/html/${paperId}`,
      mime_type: 'text/html',
      fallback: {
        file_url: `https://arxiv.org/pdf/${paperId}`,
        mime_type: 'application/pdf',
      },
      url: id,
      author: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''),
      date: safeDate(published),
    },
  };
}

/**
 * Build the arXiv API URL for one page of a query.
 *
 * @param {string} encodedQuery - The search query, already URL-encoded.
 * @param {number} page - Zero-based page number.
 * @returns {string} The endpoint to fetch.
 */
function buildQueryUrl(encodedQuery, page) {
  return `https://export.arxiv.org/api/query?search_query=${encodedQuery}&start=${page * PAGE_SIZE}&max_results=${PAGE_SIZE}&sortBy=submittedDate&sortOrder=descending`;
}

/**
 * Collect new documents from one page's entries into the shared accumulators.
 * Returns true when an entry at or behind the watermark is reached (everything
 * after it is older), signalling the caller to stop paging this query.
 *
 * @param {RegExpMatchArray[]} entries - One match per `<entry>` on the page.
 * @param {Accumulators} accumulators - State shared across every query in the round.
 * @returns {boolean} True once the watermark is reached.
 */
function collectEntries(entries, { lastDate, seenIds, documents, publishedTimes }) {
  for (const entry of entries) {
    const { documentId, publishedMs, doc } = entryToDocument(entry[1] ?? '');
    if (lastDate && !Number.isNaN(publishedMs) && publishedMs <= lastDate.getTime()) {
      return true;
    }
    if (seenIds.has(documentId)) continue;
    seenIds.add(documentId);
    if (!Number.isNaN(publishedMs)) publishedTimes.push(publishedMs);
    documents.push(doc);
  }
  return false;
}

/**
 * Page through a single query, accumulating results. Results are sorted
 * newest-first, so paging continues until a page comes back short, an entry
 * falls behind the watermark, the per-run page cap, or the soft deadline.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @param {string} query - One arXiv search query.
 * @param {Accumulators} accumulators - State shared across every query in the round.
 * @returns {Promise<void>} Resolves when this query is done or bounded out.
 */
async function syncQuery(context, query, accumulators) {
  const encoded = encodeURIComponent(query);

  for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
    if (deadlineReached(context)) {
      context.log.info('Time budget reached while paging arXiv — resuming next run');
      return;
    }

    const xml = await fetchPage(buildQueryUrl(encoded, page));
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    context.log.info(`  "${query}" page ${page + 1}: ${entries.length} papers`);

    if (collectEntries(entries, accumulators)) return;
    if (entries.length < PAGE_SIZE) return;
  }
}

/**
 * The queries to run, falling back to the two default categories.
 *
 * @param {unknown} value - The `queries` config field.
 * @returns {string[]} The queries to search for.
 */
function queriesFrom(value) {
  const configured = stringList(value);
  return configured.length > 0 ? configured : ['cat:cs.AI', 'cat:cs.LG'];
}

/**
 * Sync this source: fetch what is new and return it as documents.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @returns {Promise<import('../lib/types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function sync(context) {
  const queries = queriesFrom(context.config.queries);
  const lastDate = readDateWatermark(context.cursor);

  context.log.info(`Searching arXiv for ${queries.length} queries...`);
  /** @type {import('../lib/types.d.ts').TroveDocument[]} */
  const documents = [];
  /** @type {number[]} */
  const publishedTimes = [];
  // A paper can match several queries (e.g. cs.AI and cs.LG); emit it once.
  /** @type {Set<string>} */
  const seenIds = new Set();
  const accumulators = { lastDate, seenIds, documents, publishedTimes };
  let anyFailed = false;

  for (const query of queries) {
    try {
      await syncQuery(context, query, accumulators);
    } catch (error) {
      anyFailed = true;
      context.log.warn(
        `Failed query "${query}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    context.progress(documents.length, `${documents.length} papers`);
  }

  // Held when a query failed: advancing on the healthy queries' dates would
  // permanently skip the failed query's older papers.
  const cursor = advanceDateWatermark({
    previous: context.cursor,
    maxIso:
      publishedTimes.length > 0 ? new Date(Math.max(...publishedTimes)).toISOString() : undefined,
    anyFailed,
  });

  return { documents, cursor, stats: { fetched: documents.length } };
}
