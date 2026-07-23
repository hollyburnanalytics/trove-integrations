import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { parse } from 'node-html-parser';

afterAll(() => mock.restore());

const fetchPage = mock();
const deadlineReached = mock(() => false);

mock.module('../../lib/feeds.mjs', () => ({
  fetchPage,
  deadlineReached,
  htmlToText: (html) =>
    parse(String(html ?? ''))
      .textContent.replaceAll(/\s+/g, ' ')
      .trim(),
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
    deadlineReached.mockReturnValue(false);
    route({});
  });
  afterEach(() => jest.restoreAllMocks());

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
