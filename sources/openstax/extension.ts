import { defineSource, stringList } from '@ontrove/extend/source';
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
 */
type Release = {
  archiveUrl: string;
  books?: Record<string, { retired?: boolean; defaultVersion?: string }>;
};
type CatalogItem = { book_state?: string; title: string; cnx_id: string; meta: { slug: string } };
type Book = { slug: string; title: string; cnxId: string };
type VersionedBook = Book & { version: string };
type TreeNode = { id: string; title: string; slug: string; contents?: TreeNode[] };
type BookTree = { license?: { url?: string }; tree?: TreeNode };
type Section = { content?: string; revised?: string };
type PartialBook = { key: string; next: number };
type Checkpoint = { done: string[]; partial?: PartialBook };

/**
 * Pause between section fetches, to pace requests against the archive.
 *
 * @param ms - How long to wait.
 * @returns Resolves once the time has passed.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a URL (honest UA, timeout, size cap) and parse it as JSON.
 *
 * @param url - The endpoint to read.
 * @returns The parsed body, as the caller declares it.
 */
async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchPage(url));
}

/**
 * The active archive base URL and a map of `cnx_id → version` for live books.
 *
 * @returns Where to
 *   fetch from, and which version of each live book to fetch.
 */
async function loadRelease(): Promise<{ archiveBase: string; versions: Map<string, string> }> {
  const release: Release = await fetchJson(RELEASE_URL);
  const archiveBase = `${ORIGIN}${release.archiveUrl}`;
  const versions: Map<string, string> = new Map();
  const books = Object.entries(release.books ?? {});
  for (const [cnxId, info] of books) {
    if (!info.retired && info.defaultVersion) versions.set(cnxId, info.defaultVersion);
  }
  return { archiveBase, versions };
}

/**
 * Live books from the CMS catalog.
 *
 * @returns Every book the CMS reports as live.
 */
async function loadCatalog(): Promise<Book[]> {
  const data: { items?: CatalogItem[] } = await fetchJson(CATALOG_URL);
  return (data.items ?? [])
    .filter((item) => item.book_state === 'live')
    .map((item) => ({ slug: item.meta.slug, title: item.title, cnxId: item.cnx_id }));
}

/**
 * Flatten a book tree into its leaf sections (nodes with no children).
 *
 * @param node - The subtree to walk.
 * @param accumulator - Where leaves collect, for the recursion.
 * @returns Every leaf, in reading order.
 */
function flattenPages(node: TreeNode | undefined, accumulator: TreeNode[] = []): TreeNode[] {
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
 * @param html - The fragment.
 * @returns Its text, whitespace collapsed.
 */
function stripTags(html: string | undefined): string {
  return parse(html ?? '')
    .textContent.replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * A short licence code, e.g. `CC BY 4.0`, from a Creative Commons URL.
 *
 * @param url - The licence URL the archive reported.
 * @returns The code, or nothing when the URL names no licence.
 */
function licenseCode(url: string | undefined): string | undefined {
  const [, kind, version] = (url ?? '').match(/licenses\/([a-z-]+)\/(\d(?:\.\d)?)/i) ?? [];
  return kind && version ? `CC ${kind.toUpperCase()} ${version}` : undefined;
}

/**
 * A section's body: drop styling/scripts, keep paragraph breaks, reduce to text.
 *
 * @param html - The section fragment.
 * @returns Its text, with paragraph breaks preserved.
 */
function cleanContent(html: string | undefined): string {
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
 * @param context - The harness context.
 * @param archiveBase - The active archive's base URL.
 * @param book - The book to sync, and the version to read.
 * @param startIndex - Which leaf section to resume at.
 * @returns {Promise<{ sections: import('../lib/types.js').Document[],
 *   next: number | undefined }>} The sections collected, and where to resume.
 */
async function syncBook(
  context: import('../lib/types.js').SourceContext,
  archiveBase: string,
  book: VersionedBook,
  startIndex: number,
) {
  const { cnxId, version } = book;
  const tree: BookTree = await fetchJson(`${archiveBase}/contents/${cnxId}@${version}.json`);
  const license = licenseCode(tree.license?.url);
  const pages = flattenPages(tree.tree);
  const sections: import('../lib/types.js').Document[] = [];
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
 * @param context - The harness context.
 * @param archiveBase - The active archive's base URL.
 * @param book - The book the section belongs to.
 * @param page - The leaf node naming the section.
 * @param license - The book's licence code, carried as a tag.
 * @returns The
 *   document, or nothing for a stub or a failed fetch.
 */
async function buildSection(
  context: import('../lib/types.js').SourceContext,
  archiveBase: string,
  book: VersionedBook,
  page: TreeNode,
  license: string | undefined,
): Promise<import('../lib/types.js').Document | undefined> {
  const { cnxId, version } = book;
  const uuid = page.id.replace(/@.*/, '');
  let section: Section;
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

export default defineSource({
  id: 'openstax',
  name: 'OpenStax',
  description:
    "Free, peer-reviewed, openly licensed (Creative Commons) college textbooks across the sciences, social sciences, humanities, and business — full section text pulled from OpenStax's official content API. A bounded corpus (~130 books) backfilled incrementally.",
  icon: '📚',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'idSet',
  ingest: 'append',
  runsIn: 'mac',
  schedule: 'monthly',
  status: 'implemented',
  needsBrowser: false,
  egress: ['openstax.org'],
  egressNote:
    'The REX release manifest, the CMS book catalogue and the content archive are all paths on openstax.org.',
  async sync(context) {
    const { archiveBase, versions } = await loadRelease();
    const wanted = new Set(stringList(context.config?.books));
    const books = await loadCatalog();
    const catalog: VersionedBook[] = books.flatMap((book) => {
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
    const stored = (context.cursor as { value?: Checkpoint } | undefined)?.value;
    if (stored === undefined && context.cursor) {
      context.log.warn(
        'Resume state was not readable, so this run starts from the first book. ' +
          'This source keeps a custom checkpoint the platform cannot parse, and only ' +
          'works where the raw cursor is preserved (location: client).',
      );
    }
    const done = new Set(stored?.done);
    const resume = stored?.partial; // { key, next } — a book left mid-sync
    const documents: import('../lib/types.js').Document[] = [];
    let skipped = 0;
    let partial: PartialBook | undefined;
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
    const value: Checkpoint = { done: [...done] };
    if (partial) value.partial = partial;
    return {
      documents,
      // Cast for the same reason as the read above: the checkpoint is this
      // source's own shape, not one of the two the shared `Cursor` declares.
      cursor: { type: 'idSet', value } as unknown as import('../lib/types.js').Cursor,
      stats: { fetched: documents.length, skipped },
    };
  },
});
