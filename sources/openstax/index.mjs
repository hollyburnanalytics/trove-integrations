import { stringList } from '@ontrove/sdk';
import { parse } from 'node-html-parser';
import { fetchPage, hasDeadlinePassed, htmlToText, safeDate, stableId } from '../lib/feeds.mjs';

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
 * sync is deadline-bounded and resumes via an `idSet` cursor of finished
 * books — a big first backfill completes cleanly across several runs.
 */

const ORIGIN = 'https://openstax.org';
const RELEASE_URL = `${ORIGIN}/rex/release.json`;
const CATALOG_URL = `${ORIGIN}/apps/cms/api/v2/pages/?type=books.Book&fields=cnx_id,license_name,book_state&limit=500`;
const DELAY_MS = 300;
const MIN_WORDS = 30; // skip near-empty stubs (blank pages, bare answer keys)

/**
 * The archive payloads this source reads, plus its own resume state.
 *
 * @typedef {{ archiveUrl: string, books?: Record<string, { retired?: boolean,
 *   defaultVersion?: string }> }} Release
 * @typedef {{ book_state?: string, title: string, cnx_id: string,
 *   meta: { slug: string } }} CatalogItem
 * @typedef {{ slug: string, title: string, cnxId: string }} Book
 * @typedef {Book & { version: string }} VersionedBook
 * @typedef {{ id: string, title: string, slug: string, contents?: TreeNode[] }} TreeNode
 * @typedef {{ license?: { url?: string }, tree?: TreeNode }} BookTree
 * @typedef {{ content?: string, revised?: string }} Section
 * @typedef {{ key: string, next: number }} PartialBook
 * @typedef {{ done: string[], partial?: PartialBook }} Checkpoint
 */

/**
 * Pause between section fetches, to pace requests against the archive.
 *
 * @param {number} ms - How long to wait.
 * @returns {Promise<void>} Resolves once the time has passed.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a URL (honest UA, timeout, size cap) and parse it as JSON.
 *
 * @template T
 * @param {string} url - The endpoint to read.
 * @returns {Promise<T>} The parsed body, as the caller declares it.
 */
async function fetchJson(url) {
  return JSON.parse(await fetchPage(url));
}

/**
 * The active archive base URL and a map of `cnx_id → version` for live books.
 *
 * @returns {Promise<{ archiveBase: string, versions: Map<string, string> }>} Where to
 *   fetch from, and which version of each live book to fetch.
 */
async function loadRelease() {
  /** @type {Release} */
  const release = await fetchJson(RELEASE_URL);
  const archiveBase = `${ORIGIN}${release.archiveUrl}`;
  /** @type {Map<string, string>} */
  const versions = new Map();
  const books = Object.entries(release.books ?? {});
  for (const [cnxId, info] of books) {
    if (!info.retired && info.defaultVersion) versions.set(cnxId, info.defaultVersion);
  }
  return { archiveBase, versions };
}

/**
 * Live books from the CMS catalog.
 *
 * @returns {Promise<Book[]>} Every book the CMS reports as live.
 */
async function loadCatalog() {
  /** @type {{ items?: CatalogItem[] }} */
  const data = await fetchJson(CATALOG_URL);
  return (data.items ?? [])
    .filter((item) => item.book_state === 'live')
    .map((item) => ({ slug: item.meta.slug, title: item.title, cnxId: item.cnx_id }));
}

/**
 * Flatten a book tree into its leaf sections (nodes with no children).
 *
 * @param {TreeNode | undefined} node - The subtree to walk.
 * @param {TreeNode[]} [accumulator] - Where leaves collect, for the recursion.
 * @returns {TreeNode[]} Every leaf, in reading order.
 */
function flattenPages(node, accumulator = []) {
  const children = node?.contents ?? [];
  for (const child of children) {
    if (child.contents) flattenPages(child, accumulator);
    else accumulator.push(child);
  }
  return accumulator;
}

/**
 * Plain text from an HTML fragment (drop the title's nested markup spans).
 *
 * @param {string | undefined} html - The fragment.
 * @returns {string} Its text, whitespace collapsed.
 */
function stripTags(html) {
  return parse(html ?? '')
    .textContent.replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * A short licence code, e.g. `CC BY 4.0`, from a Creative Commons URL.
 *
 * @param {string | undefined} url - The licence URL the archive reported.
 * @returns {string | undefined} The code, or nothing when the URL names no licence.
 */
function licenseCode(url) {
  const [, kind, version] = (url ?? '').match(/licenses\/([a-z-]+)\/(\d(?:\.\d)?)/i) ?? [];
  return kind && version ? `CC ${kind.toUpperCase()} ${version}` : undefined;
}

/**
 * A section's body: drop styling/scripts, keep paragraph breaks, reduce to text.
 *
 * @param {string | undefined} html - The section fragment.
 * @returns {string} Its text, with paragraph breaks preserved.
 */
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
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @param {string} archiveBase - The active archive's base URL.
 * @param {VersionedBook} book - The book to sync, and the version to read.
 * @param {number} startIndex - Which leaf section to resume at.
 * @returns {Promise<{ sections: import('../lib/types.d.ts').TroveDocument[],
 *   next: number | undefined }>} The sections collected, and where to resume.
 */
async function syncBook(context, archiveBase, book, startIndex) {
  const { cnxId, version } = book;
  /** @type {BookTree} */
  const tree = await fetchJson(`${archiveBase}/contents/${cnxId}@${version}.json`);
  const license = licenseCode(tree.license?.url);
  const pages = flattenPages(tree.tree);
  /** @type {import('../lib/types.d.ts').TroveDocument[]} */
  const sections = [];
  for (const [offset, page] of pages.slice(startIndex).entries()) {
    if (hasDeadlinePassed(context)) return { sections, next: startIndex + offset };
    const document = await buildSection(context, archiveBase, book, page, license);
    if (document) {
      sections.push(document);
      await sleep(DELAY_MS);
    }
  }
  return { sections, next: undefined };
}

/**
 * Build one section document, or undefined if it's an empty stub / fetch fails.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @param {string} archiveBase - The active archive's base URL.
 * @param {VersionedBook} book - The book the section belongs to.
 * @param {TreeNode} page - The leaf node naming the section.
 * @param {string | undefined} license - The book's licence code, carried as a tag.
 * @returns {Promise<import('../lib/types.d.ts').TroveDocument | undefined>} The
 *   document, or nothing for a stub or a failed fetch.
 */
async function buildSection(context, archiveBase, book, page, license) {
  const { cnxId, version } = book;
  const uuid = page.id.replace(/@.*/, '');
  /** @type {Section} */
  let section;
  try {
    section = await fetchJson(`${archiveBase}/contents/${cnxId}@${version}:${uuid}.json`);
  } catch (error) {
    context.log.warn(
      `OpenStax section ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const text = cleanContent(section.content);
  if (text.split(/\s+/).length < MIN_WORDS) return;
  return {
    id: stableId('openstax', `${cnxId}:${uuid}`),
    title: `${book.title} — ${stripTags(page.title)}`,
    text,
    url: `${ORIGIN}/books/${book.slug}/pages/${page.slug}`,
    author: 'OpenStax',
    date: safeDate(section.revised),
    tags: [book.title, license].filter((tag) => tag !== undefined),
  };
}

/**
 * Sync this source: fetch what is new and return it as documents.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @returns {Promise<import('../lib/types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function sync(context) {
  const { archiveBase, versions } = await loadRelease();
  const wanted = new Set(stringList(context.config?.books));
  const books = await loadCatalog();
  /** @type {VersionedBook[]} */
  const catalog = books.flatMap((book) => {
    const version = versions.get(book.cnxId);
    if (version === undefined) return [];
    if (wanted.size > 0 && !wanted.has(book.slug)) return [];
    return [{ ...book, version }];
  });

  // This source's resume state is NOT an idSet, whatever the manifest says: it
  // is `{ done: string[], partial?: { key, next } }` — which books are finished
  // plus one left mid-sync. Trove's `parseWatermark` models three shapes and
  // this is a fourth, so in the cloud it would parse to null and every run
  // would restart from zero books. That is survivable here ONLY because this
  // source is `location: client`, where the Mac hands the raw cursor back
  // untouched.
  //
  // Said out loud rather than left implicit, because the failure is silent: a
  // full re-sync looks exactly like a first sync.
  //
  // The cast is the boundary the shared `Cursor` union points at: this is the
  // one source whose checkpoint is its own shape, and it says so here rather
  // than widening the vocabulary every other source shares.
  const stored = /** @type {{ value?: Checkpoint } | undefined} */ (context.cursor)?.value;
  if (stored === undefined && context.cursor) {
    context.log.warn(
      'Resume state was not readable, so this run starts from the first book. ' +
        'This source keeps a custom checkpoint the platform cannot parse, and only ' +
        'works where the raw cursor is preserved (location: client).',
    );
  }
  const done = new Set(stored?.done);
  const resume = stored?.partial; // { key, next } — a book left mid-sync
  /** @type {import('../lib/types.d.ts').TroveDocument[]} */
  const documents = [];
  let skipped = 0;
  /** @type {PartialBook | undefined} */
  let partial;
  for (const book of catalog) {
    const key = `${book.slug}@${book.version}`;
    if (done.has(key)) {
      skipped++;
      continue;
    }
    if (hasDeadlinePassed(context)) break;
    const start = resume?.key === key ? resume.next : 0;
    const { sections, next } = await syncBook(context, archiveBase, book, start);
    documents.push(...sections);
    if (next !== undefined) {
      partial = { key, next };
      break; // deadline hit mid-book — resume this page next run
    }
    done.add(key);
    context.progress(documents.length, `Synced ${book.title}`);
  }

  /** @type {Checkpoint} */
  const value = { done: [...done] };
  if (partial) value.partial = partial;
  return {
    documents,
    // Cast for the same reason as the read above: the checkpoint is this
    // source's own shape, not one of the two the shared `Cursor` declares.
    cursor: /** @type {import('../lib/types.d.ts').Cursor} */ (
      /** @type {unknown} */ ({ type: 'idSet', value })
    ),
    stats: { fetched: documents.length, skipped },
  };
}
