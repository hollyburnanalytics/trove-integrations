import { deadlineReached, decodeHtmlEntities, fetchPage } from '../../lib/feeds.mjs';
import { advanceDateWatermark, readDateWatermark } from '../../lib/watermark.mjs';

/** Results per arXiv API page. */
export const PAGE_SIZE = 100;
/**
 * Page cap per query per run. Bounds a cold backfill (no watermark yet) to
 * PAGE_SIZE * MAX_PAGES_PER_QUERY papers; the watermark carries on from there
 * on later runs, so nothing is lost — just spread across runs.
 */
const MAX_PAGES_PER_QUERY = 5;

const getTagValue = (xml, tag) => {
  const m = xml.match(new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`));
  return m ? m[1].trim() : '';
};

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
  ].map((m) => m[1].trim());

  return {
    documentId: `arxiv-${id.split('/').pop()}`,
    publishedMs: published ? new Date(published).getTime() : Number.NaN,
    doc: {
      id: `arxiv-${id.split('/').pop()}`,
      title,
      text: `${title}\n\n${summary}`,
      url: id,
      author: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''),
      date: published ? new Date(published).toISOString() : new Date().toISOString(),
    },
  };
}

/** Build the arXiv API URL for one page of a query. */
function buildQueryUrl(encodedQuery, page) {
  return `https://export.arxiv.org/api/query?search_query=${encodedQuery}&start=${page * PAGE_SIZE}&max_results=${PAGE_SIZE}&sortBy=submittedDate&sortOrder=descending`;
}

/**
 * Collect new documents from one page's entries into the shared accumulators.
 * Returns true when an entry at or behind the watermark is reached (everything
 * after it is older), signalling the caller to stop paging this query.
 */
function collectEntries(entries, { lastDate, seenIds, documents, publishedTimes }) {
  for (const entry of entries) {
    const { documentId, publishedMs, doc } = entryToDocument(entry[1]);
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

export async function sync(context) {
  const queries = context.config.queries || ['cat:cs.AI', 'cat:cs.LG'];
  const lastDate = readDateWatermark(context.cursor);

  context.log.info(`Searching arXiv for ${queries.length} queries...`);
  const documents = [];
  const publishedTimes = [];
  // A paper can match several queries (e.g. cs.AI and cs.LG); emit it once.
  const seenIds = new Set();
  const accumulators = { lastDate, seenIds, documents, publishedTimes };
  let anyFailed = false;

  for (const query of queries) {
    try {
      await syncQuery(context, query, accumulators);
    } catch (error) {
      anyFailed = true;
      context.log.warn(`Failed query "${query}": ${error.message}`);
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
