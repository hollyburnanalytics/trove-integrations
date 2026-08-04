import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
// The REAL converter, imported from the module that defines it so this mock
// cannot shadow it. See the note on `htmlToText` below.
import { htmlToText } from '../../lib/html-markdown.mjs';

afterAll(() => mock.restore());

import { okResponse } from '../../lib/feed-fixtures.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Stands in for `fetchPage` WITHOUT mocking it in the module registry — see the
 * note below on how far a `mock.module` of this barrel reaches. Routing stays
 * exactly as these tests wrote it; only the seam moved to `fetch`.
 */
const fetchPage = mock();

function installFetch() {
  globalThis.fetch = mock(async (url) => okResponse(await fetchPage(String(url))));
}

// Faithful by default: this registry entry is process-global, so a hard-coded
// `false` would silently disable deadline handling in every other suite that
// reaches `deadlineReached` through this specifier. Tests override explicitly.
const deadlineReached = mock((context) => realFeeds.deadlineReached(context));

// Spread the real module first — anything omitted here becomes `undefined` for
// every OTHER source importing this specifier, not just for this suite.
import * as realFeeds from '../../lib/feeds.mjs';

mock.module('../../lib/feeds.mjs', () => ({
  ...realFeeds,
  deadlineReached,
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
  safeDate: (value) => {
    if (!value) return;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  },
  stableId: (prefix, input) => `${prefix}-${input}`,
}));

const { sync } = await import('./index.mjs');

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

function route(map) {
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

const context = (overrides = {}) => ({
  log: { info: jest.fn(), warn: jest.fn() },
  progress: jest.fn(),
  config: {},
  cursor: undefined,
  ...overrides,
});

describe('openstax source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installFetch();
    deadlineReached.mockReturnValue(false);
    route({});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  it('syncs a book into one document per section, skipping stubs and fetch failures', async () => {
    const runContext = context();
    const result = await sync(runContext);

    // P1 + P2 only (P3 empty content, P4 fetch error)
    expect(result.documents).toHaveLength(2);
    const [preface, intro] = result.documents;
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

  it('skips books already recorded in the watermark', async () => {
    const result = await sync(
      context({ cursor: { type: 'idSet', value: { done: ['book-one@v1'] } } }),
    );
    expect(result.documents).toHaveLength(0);
    expect(result.stats.skipped).toBe(1);
  });

  it('honours a config.books allow-list', async () => {
    const result = await sync(context({ config: { books: ['something-else'] } }));
    expect(result.documents).toHaveLength(0);
    expect(result.cursor.value.done).toEqual([]);
  });

  it('stops before any book when the deadline has already passed', async () => {
    deadlineReached.mockReturnValue(true);
    const result = await sync(context());
    expect(result.documents).toHaveLength(0);
    expect(result.cursor.value.partial).toBeUndefined();
  });

  it('records a page-level partial cursor when the deadline interrupts a book', async () => {
    // false (sync pre-book), false (page 0), true (page 1 → interrupt)
    deadlineReached.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    const result = await sync(context());
    expect(result.documents).toHaveLength(1); // only P1 before the interrupt
    expect(result.cursor.value.partial).toEqual({ key: 'book-one@v1', next: 1 });
    expect(result.cursor.value.done).toEqual([]);
  });

  it('resumes a partial book from the saved page index', async () => {
    const result = await sync(
      context({
        cursor: { type: 'idSet', value: { done: [], partial: { key: 'book-one@v1', next: 1 } } },
      }),
    );
    // resumes at index 1 → P2 only (P3 empty, P4 error); never re-emits P1
    expect(result.documents.map((d) => d.id)).toEqual(['openstax-CNX1:P2']);
    expect(result.cursor.value.done).toEqual(['book-one@v1']);
    expect(result.cursor.value.partial).toBeUndefined();
  });

  it('omits the licence tag when the book uses a non-Creative-Commons URL', async () => {
    route({ tree: { ...TREE, license: { url: 'https://example.com/all-rights' } } });
    const { documents } = await sync(context());
    expect(documents[0].tags).toEqual(['Book One']);
  });

  it('returns nothing when the catalog is empty', async () => {
    route({ catalog: {} }); // items undefined → []
    const result = await sync(context());
    expect(result.documents).toHaveLength(0);
  });
});
