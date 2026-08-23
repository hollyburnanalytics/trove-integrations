import {
  advanceDateCursor,
  defineSource,
  readDateCursor,
  stringList,
} from '@ontrove/extend/source';
import { decodeHtmlEntities, fetchPage, hasDeadlinePassed, safeDate } from '../lib/feeds.ts';

/** Results per arXiv API page. */
export const PAGE_SIZE = 100;
/**
 * Page cap per query per run. Bounds a cold backfill (no cursor yet) to
 * PAGE_SIZE * MAX_PAGES_PER_QUERY papers; the cursor carries on from there
 * on later runs, so nothing is lost — just spread across runs.
 */
const MAX_PAGES_PER_QUERY = 5;

/**
 * One Atom element's text content, or `''`.
 *
 */
const getTagValue: (xml: string, tag: string) => string = (xml, tag) => {
  const [, value] = xml.match(new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`)) ?? [];
  return value ? value.trim() : '';
};

type PaperEntry = {
  documentId: string;
  publishedMs: number;
  doc: import('../lib/types.js').Document;
};
type Accumulators = {
  lastDate: Date | undefined;
  seenIds: Set<string>;
  documents: import('../lib/types.js').Document[];
  publishedTimes: number[];
};

/**
 * Project one `<entry>` onto a document, plus what the caller needs to decide
 * whether to keep it.
 *
 * @param entryXml - The entry's markup.
 * @returns The document and its identity and publication time.
 */
function entryToDocument(entryXml: string): PaperEntry {
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
    publishedMs: published ? new Date(published).getTime() : NaN,
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
      fileUrl: `https://arxiv.org/html/${paperId}`,
      mimeType: 'text/html',
      fallback: {
        fileUrl: `https://arxiv.org/pdf/${paperId}`,
        mimeType: 'application/pdf',
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
 * @param encodedQuery - The search query, already URL-encoded.
 * @param page - Zero-based page number.
 * @returns The endpoint to fetch.
 */
function buildQueryUrl(encodedQuery: string, page: number): string {
  return `https://export.arxiv.org/api/query?search_query=${encodedQuery}&start=${page * PAGE_SIZE}&max_results=${PAGE_SIZE}&sortBy=submittedDate&sortOrder=descending`;
}

/**
 * Collect new documents from one page's entries into the shared accumulators.
 * Returns true when an entry at or behind the cursor is reached (everything
 * after it is older), signalling the caller to stop paging this query.
 *
 * @param entries - One match per `<entry>` on the page.
 * @param accumulators - State shared across every query in the round.
 * @returns True once the cursor is reached.
 */
function collectEntries(
  entries: RegExpMatchArray[],
  { lastDate, seenIds, documents, publishedTimes }: Accumulators,
): boolean {
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
 * falls behind the cursor, the per-run page cap, or the soft deadline.
 *
 * @param context - The harness context.
 * @param query - One arXiv search query.
 * @param accumulators - State shared across every query in the round.
 * @returns Resolves when this query is done or bounded out.
 */
async function syncQuery(
  context: import('../lib/types.js').SourceContext,
  query: string,
  accumulators: Accumulators,
): Promise<void> {
  const encoded = encodeURIComponent(query);

  for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
    if (hasDeadlinePassed(context)) {
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
 * @param value - The `queries` config field.
 * @returns The queries to search for.
 */
function queriesFrom(value: unknown): string[] {
  const configured = stringList(value);
  return configured.length > 0 ? configured : ['cat:cs.AI', 'cat:cs.LG'];
}

export default defineSource({
  id: 'arxiv-papers',
  name: 'arXiv Papers',
  description: 'ML and CS paper abstracts matching your search queries',
  icon: '📄',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'every 6 hours',
  status: 'implemented',
  needsBrowser: false,
  egress: ['export.arxiv.org'],
  historyReach: {
    kind: 'full',
    note: 'arXiv answers any date range. A run fetches up to 500 papers per query and the next run carries on, so a deep backfill arrives over several syncs rather than all at once.',
  },
  egressNote:
    "The adapter queries the arXiv API on export.arxiv.org. arxiv.org appears only as the paper's HTML/PDF `file_url`, which Trove's ingest fetches when it captures the artifact.",
  egressNotFetched: ['arxiv.org'],
  config: {
    queries: {
      label: 'Search Queries',
      type: 'text[]',
      directory: {
        provider: 'arxiv',
        mode: 'search',
        placeholder: 'Search arXiv subjects',
      },
    },
  },
  fanOut: 'queries',
  formatting: 'verbatim',
  async sync(context) {
    const queries = queriesFrom(context.config.queries);
    const lastDate = readDateCursor(context.cursor);

    context.log.info(`Searching arXiv for ${queries.length} queries...`);
    const documents: import('../lib/types.js').Document[] = [];
    const publishedTimes: number[] = [];
    // A paper can match several queries (e.g. cs.AI and cs.LG); emit it once.
    const seenIds: Set<string> = new Set();
    const accumulators = { lastDate, seenIds, documents, publishedTimes };
    let isAnyFailed = false;

    for (const query of queries) {
      try {
        await syncQuery(context, query, accumulators);
      } catch (error) {
        isAnyFailed = true;
        context.log.warn(
          `Failed query "${query}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      context.progress(documents.length, `${documents.length} papers`);
    }

    // Held when a query failed: advancing on the healthy queries' dates would
    // permanently skip the failed query's older papers.
    const cursor = advanceDateCursor({
      previous: context.cursor,
      maxIso:
        publishedTimes.length > 0 ? new Date(Math.max(...publishedTimes)).toISOString() : undefined,
      anyFailed: isAnyFailed,
    });

    return { documents, cursor, stats: { fetched: documents.length } };
  },
});
