import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The REAL converter, imported from the module that defines it so this mock
// cannot shadow it. See the note on `htmlToText` below.
import { htmlToText } from '../lib/html-markdown.ts';

afterAll(() => vi.restoreAllMocks());

import { at, makeSourceContext, okResponse, setFetch, syncOf } from '../lib/test-fixtures.ts';
import type { Cursor, SourceContext } from '../lib/types.js';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Stands in for `fetchPage` WITHOUT mocking it in the module registry — see the
 * note below on how far a `mock.module` of this barrel reaches. Routing stays
 * exactly as these tests wrote it; only the seam moved to `fetch`.
 */
const fetchPage = vi.fn();

function installFetch() {
  setFetch(async (url) => okResponse(await fetchPage(String(url))));
}

// Faithful by default: this registry entry is process-global, so a hard-coded
// `false` would silently disable deadline handling in every other suite that
// reaches `hasDeadlinePassed` through this specifier. Tests override explicitly.

// Spread the real module first — anything omitted here becomes `undefined` for
// every OTHER source importing this specifier, not just for this suite.
//
// The spy delegates to the real implementation resolved INSIDE the factory:
// `vi.mock` is hoisted above the imports, so a module-scope binding would not
// exist yet when this runs.
vi.mock('../lib/feeds.ts', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('../lib/feeds.ts');
  return {
    ...real,
    hasDeadlinePassed: vi.fn((context: SourceContext) => real.hasDeadlinePassed(context)),
    // The REAL implementation, not a stand-in.
    //
    // This was a tag-stripper — `parse(html).textContent` — and it broke the
    // hacker-news suite on Linux CI while passing on macOS, for two days of
    // apparent flakiness. Bun's module mocks leak across test files and the file
    // execution order differs by platform, so whenever this file happened to run
    // first, every later suite got a converter that silently discarded links.
    //
    // The stripper agreed with the real function while the real one also
    // discarded links; the moment the converter started keeping them, the lie
    // became a failure — in a different directory, on one platform only. A mock
    // of shared infrastructure has to be faithful or it is a time bomb with a
    // delay measured in refactors.
    htmlToText,
    // Faithful to the real safeDate: undefined for missing AND invalid dates.
    // (`new Date(invalid).toISOString()` throws — and module mocks can leak
    // across test files, so an unfaithful mock here breaks other suites.)
    safeDate: (value: string | undefined): string | undefined => {
      if (!value) return;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    },
    stableId: (prefix: string, input: string) => `${prefix}-${input}`,
  };
});

// The spy lives in the mocked module now — `vi.mock` is hoisted, so it cannot
// be a module-scope binding declared beside it.
const { hasDeadlinePassed } = await import('../lib/feeds.ts');
const { default: extension } = await import('./extension.ts');
const sync = syncOf(extension);

const RELEASE = {
  archiveUrl: '/apps/archive/V1',
  books: {
    CNX1: { defaultVersion: 'v1' },
    CNX2: { defaultVersion: 'v2', retired: true }, // retired → no version
    CNX3: {}, // missing defaultVersion → no version
  },
};

const CATALOG = {
  items: [
    {
      meta: { slug: 'book-one', html_url: 'https://openstax.org/details/books/book-one' },
      title: 'Book One',
      cnx_id: 'CNX1',
      book_state: 'live',
    },
    {
      meta: { slug: 'draft-book', html_url: 'u' },
      title: 'Draft',
      cnx_id: 'CNX1',
      book_state: 'new',
    }, // not live
    {
      meta: { slug: 'no-version', html_url: 'u' },
      title: 'NoVer',
      cnx_id: 'CNX3',
      book_state: 'live',
    }, // no version → filtered
  ],
};

const TREE = {
  title: 'Book One',
  slug: 'book-one',
  license: { url: 'https://creativecommons.org/licenses/by/4.0/' },
  tree: {
    contents: [
      { id: 'P1@', title: '<span>Preface</span>', slug: 'preface' },
      {
        id: 'C1@v1',
        title: 'Chapter 1',
        contents: [
          { id: 'P2@v1', title: undefined, slug: 'intro' }, // title undefined → stripTags '' branch
          { id: 'P3@', title: 'Stub', slug: 'stub' }, // empty content → skipped
          { id: 'P4@', title: 'Boom', slug: 'boom' }, // fetch throws → warn
        ],
      },
    ],
  },
};

const longText = `<p>${'word '.repeat(40)}</p>`;
const SECTIONS = {
  P1: { content: `<style>.x{color:#fff}</style>${longText}`, revised: '2024-01-02' },
  P2: { content: longText }, // no revised → safeDate undefined
  P3: { content: undefined }, // → cleanContent '' → skipped
};

/**
 * Route `fetchPage` over the fixture payloads.
 *
 * @param map - Payload
 *   overrides; anything omitted falls back to the module-level fixture.
 * @returns Nothing; it installs the implementation.
 */
function route(map: { release?: unknown; catalog?: unknown; tree?: unknown }): void {
  fetchPage.mockImplementation(async (url) => {
    if (url.includes('/rex/release.json')) return JSON.stringify(map.release ?? RELEASE);
    if (url.includes('type=books.Book')) return JSON.stringify(map.catalog ?? CATALOG);
    if (url.includes(':P4')) throw new Error('boom');
    if (url.includes(':P1')) return JSON.stringify(SECTIONS.P1);
    if (url.includes(':P2')) return JSON.stringify(SECTIONS.P2);
    if (url.includes(':P3')) return JSON.stringify(SECTIONS.P3);
    if (url.includes('CNX1@v1.json')) return JSON.stringify(map.tree ?? TREE);
    throw new Error(`unrouted ${url}`);
  });
}

/**
 * A context for this source.
 *
 * @param overrides - Fields to replace.
 * @returns The context.
 */
const context = (overrides: Partial<SourceContext> = {}): SourceContext =>
  makeSourceContext(overrides);

/**
 * openstax's resume state: which books are finished, and where a book that ran
 * out of time should pick up. Neither shape the shared `Cursor` declares.
 */
type OpenstaxCheckpoint = {
  /** The keys of the books already fully synced. */
  done: string[];
  /** The book left mid-sync, and the leaf section to resume at. */
  partial?: { key: string; next: number };
};

/**
 * The bespoke checkpoint this source keeps, read back off the cursor it returned.
 *
 * openstax's resume state is `{ done, partial }` rather than either shape the
 * shared `Cursor` declares — deliberately, and documented at the source's own
 * boundary. The assertions have to reach the same way the source does.
 *
 * @param cursor - What `sync` returned.
 * @returns The checkpoint.
 */
function checkpoint(cursor: Cursor | undefined): OpenstaxCheckpoint {
  const value = (cursor as { value?: OpenstaxCheckpoint } | undefined)?.value;
  if (!value) throw new Error(`expected an openstax checkpoint, got ${JSON.stringify(cursor)}`);
  return value;
}

/**
 * A context resuming from an openstax checkpoint.
 *
 * @param value - The checkpoint.
 * @returns The context.
 */
function resuming(value: OpenstaxCheckpoint): SourceContext {
  return context({
    cursor: { type: 'idSet', value } as unknown as Cursor,
  });
}

describe('openstax source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
    vi.mocked(hasDeadlinePassed).mockReturnValue(false);
    route({});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('syncs a book into one document per section, skipping stubs and fetch failures', async () => {
    const runContext = context();
    const result = await sync(runContext);

    // P1 + P2 only (P3 empty content, P4 fetch error)
    expect(result.documents).toHaveLength(2);
    const preface = at(result.documents, 0);
    const intro = at(result.documents, 1);
    expect(preface).toEqual({
      id: 'openstax-CNX1:P1',
      title: 'Book One — Preface',
      text: expect.any(String),
      url: 'https://openstax.org/books/book-one/pages/preface',
      author: 'OpenStax',
      date: '2024-01-02T00:00:00.000Z',
      tags: ['Book One', 'CC BY 4.0'],
    });
    expect(preface.text).not.toContain('color:#fff'); // <style> stripped
    expect(intro.title).toBe('Book One — '); // undefined section title → blank
    expect(intro.date).toBeUndefined(); // no `revised`
    expect(result.cursor).toEqual({ type: 'idSet', value: { done: ['book-one@v1'] } });
    expect(result.stats).toEqual({ fetched: 2, skipped: 0 });
    expect(runContext.log.warn).toHaveBeenCalledTimes(1); // P4
    expect(runContext.progress).toHaveBeenCalledWith(2, 'Synced Book One');
  });

  it('skips books already recorded in the cursor', async () => {
    const result = await sync(resuming({ done: ['book-one@v1'] }));
    expect(result.documents).toHaveLength(0);
    expect(result.stats?.skipped).toBe(1);
  });

  it('honours a config.books allow-list', async () => {
    const result = await sync(context({ config: { books: ['something-else'] } }));
    expect(result.documents).toHaveLength(0);
    expect(checkpoint(result.cursor).done).toEqual([]);
  });

  it('stops before any book when the deadline has already passed', async () => {
    vi.mocked(hasDeadlinePassed).mockReturnValue(true);
    const result = await sync(context());
    expect(result.documents).toHaveLength(0);
    expect(checkpoint(result.cursor).partial).toBeUndefined();
  });

  it('records a page-level partial cursor when the deadline interrupts a book', async () => {
    // false (sync pre-book), false (page 0), true (page 1 → interrupt)
    vi.mocked(hasDeadlinePassed)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const result = await sync(context());
    expect(result.documents).toHaveLength(1); // only P1 before the interrupt
    expect(checkpoint(result.cursor).partial).toEqual({ key: 'book-one@v1', next: 1 });
    expect(checkpoint(result.cursor).done).toEqual([]);
  });

  it('resumes a partial book from the saved page index', async () => {
    const result = await sync(resuming({ done: [], partial: { key: 'book-one@v1', next: 1 } }));
    // resumes at index 1 → P2 only (P3 empty, P4 error); never re-emits P1
    expect(result.documents.map((d) => d.id)).toEqual(['openstax-CNX1:P2']);
    expect(checkpoint(result.cursor).done).toEqual(['book-one@v1']);
    expect(checkpoint(result.cursor).partial).toBeUndefined();
  });

  it('omits the licence tag when the book uses a non-Creative-Commons URL', async () => {
    route({ tree: { ...TREE, license: { url: 'https://example.com/all-rights' } } });
    const { documents } = await sync(context());
    expect(at(documents, 0).tags).toEqual(['Book One']);
  });

  it('returns nothing when the catalog is empty', async () => {
    route({ catalog: {} }); // items undefined → []
    const result = await sync(context());
    expect(result.documents).toHaveLength(0);
  });
});
