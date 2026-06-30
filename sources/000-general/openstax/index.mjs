import { parse } from 'node-html-parser';
import { deadlineReached, fetchPage, htmlToText, safeDate, stableId } from '../../lib/feeds.mjs';

/**
 * OpenStax — free, peer-reviewed, openly licensed college textbooks.
 *
 * Content comes from the same public archive API the openstax.org reader uses:
 *  - `rex/release.json`        → the active archive path + each book's version,
 *  - the CMS book catalog      → live books with slug, title, licence, `cnx_id`,
 *  - `…/contents/{id}@{ver}`   → a book's table-of-contents tree, and
 *  - `…/contents/{id}@{ver}:{page}` → one section's body as an HTML fragment.
 *
 * One document per section. The corpus is bounded (~130 books) but large, so the
 * sync is deadline-bounded and resumes via an `idSet` watermark of finished
 * books — a big first backfill completes cleanly across several runs.
 */

const ORIGIN = 'https://openstax.org';
const RELEASE_URL = `${ORIGIN}/rex/release.json`;
const CATALOG_URL = `${ORIGIN}/apps/cms/api/v2/pages/?type=books.Book&fields=cnx_id,license_name,book_state&limit=500`;
const DELAY_MS = 300;
const MIN_WORDS = 30; // skip near-empty stubs (blank pages, bare answer keys)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch a URL (honest UA, timeout, size cap) and parse it as JSON. */
async function fetchJson(url) {
  return JSON.parse(await fetchPage(url));
}

/** The active archive base URL and a map of `cnx_id → version` for live books. */
async function loadRelease() {
  const release = await fetchJson(RELEASE_URL);
  const archiveBase = `${ORIGIN}${release.archiveUrl}`;
  const versions = new Map();
  for (const [cnxId, info] of Object.entries(release.books ?? {})) {
    if (!info.retired && info.defaultVersion) versions.set(cnxId, info.defaultVersion);
  }
  return { archiveBase, versions };
}

/** Live books from the CMS catalog: `{ slug, title, cnxId }`. */
async function loadCatalog() {
  const data = await fetchJson(CATALOG_URL);
  return (data.items ?? [])
    .filter((item) => item.book_state === 'live')
    .map((item) => ({ slug: item.meta.slug, title: item.title, cnxId: item.cnx_id }));
}

/** Flatten a book tree into its leaf sections (nodes with no children). */
function flattenPages(node, accumulator = []) {
  for (const child of node?.contents ?? []) {
    if (child.contents) flattenPages(child, accumulator);
    else accumulator.push(child);
  }
  return accumulator;
}

/** Plain text from an HTML fragment (drop the title's nested markup spans). */
function stripTags(html) {
  return parse(html ?? '')
    .textContent.replaceAll(/\s+/g, ' ')
    .trim();
}

/** A short licence code, e.g. `CC BY 4.0`, from a Creative Commons URL. */
function licenseCode(url) {
  const match = (url ?? '').match(/licenses\/([a-z-]+)\/(\d(?:\.\d)?)/i);
  return match ? `CC ${match[1].toUpperCase()} ${match[2]}` : undefined;
}

/** A section's body: drop styling/scripts, keep paragraph breaks, reduce to text. */
function cleanContent(html) {
  const root = parse(html ?? '');
  for (const element of root.querySelectorAll('script, style, noscript')) element.remove();
  const withBreaks = root.innerHTML.replaceAll(/<\/(?:p|h[1-6]|li|blockquote)>/gi, '$&\n\n');
  return htmlToText(withBreaks);
}

/**
 * Sync a book's sections starting at `startIndex`. Returns the documents plus
 * `next`: the index to resume at if the deadline interrupted the book, or
 * undefined when the book finished — so a book larger than one time budget makes
 * page-by-page progress instead of restarting forever.
 */
async function syncBook(context, archiveBase, book, version, startIndex) {
  const tree = await fetchJson(`${archiveBase}/contents/${book.cnxId}@${version}.json`);
  const license = licenseCode(tree.license?.url);
  const pages = flattenPages(tree.tree);
  const sections = [];
  for (let index = startIndex; index < pages.length; index++) {
    if (deadlineReached(context)) return { sections, next: index };
    const document = await buildSection(context, archiveBase, book, version, pages[index], license);
    if (document) {
      sections.push(document);
      await sleep(DELAY_MS);
    }
  }
  return { sections, next: undefined };
}

/** Build one section document, or undefined if it's an empty stub / fetch fails. */
async function buildSection(context, archiveBase, book, version, page, license) {
  const uuid = page.id.split('@')[0];
  let section;
  try {
    section = await fetchJson(`${archiveBase}/contents/${book.cnxId}@${version}:${uuid}.json`);
  } catch (error) {
    context.log.warn(`OpenStax section ${uuid} failed: ${error.message}`);
    return;
  }
  const text = cleanContent(section.content);
  if (text.split(/\s+/).length < MIN_WORDS) return;
  return {
    id: stableId('openstax', `${book.cnxId}:${uuid}`),
    title: `${book.title} — ${stripTags(page.title)}`,
    text,
    url: `${ORIGIN}/books/${book.slug}/pages/${page.slug}`,
    author: 'OpenStax',
    date: safeDate(section.revised),
    tags: [book.title, license].filter(Boolean),
  };
}

export async function sync(context) {
  const { archiveBase, versions } = await loadRelease();
  const wanted = new Set((context.config?.books ?? []).map(String));
  const books = await loadCatalog();
  const catalog = books.filter(
    (book) => versions.has(book.cnxId) && (wanted.size === 0 || wanted.has(book.slug)),
  );

  const done = new Set(context.cursor?.value?.done);
  const resume = context.cursor?.value?.partial; // { key, next } — a book left mid-sync
  const documents = [];
  let skipped = 0;
  let partial;
  for (const book of catalog) {
    const version = versions.get(book.cnxId);
    const key = `${book.slug}@${version}`;
    if (done.has(key)) {
      skipped++;
      continue;
    }
    if (deadlineReached(context)) break;
    const start = resume?.key === key ? resume.next : 0;
    const { sections, next } = await syncBook(context, archiveBase, book, version, start);
    documents.push(...sections);
    if (next !== undefined) {
      partial = { key, next };
      break; // deadline hit mid-book — resume this page next run
    }
    done.add(key);
    context.progress(documents.length, `Synced ${book.title}`);
  }

  const value = { done: [...done] };
  if (partial) value.partial = partial;
  return {
    documents,
    cursor: { type: 'idSet', value },
    stats: { fetched: documents.length, skipped },
  };
}
