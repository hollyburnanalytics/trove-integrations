/**
 * Test fixtures shared across this catalog's source adapters.
 *
 * The twin of `sources/lib/test-fixtures.mjs` in trove-matt-helm, and named to
 * match it: the two catalogs meet the same platform, so their tests should be
 * wrong in the same ways or in neither, and a helper worth having in one is
 * worth copying into the other under the same name.
 *
 * Source tests drive the REAL `syncFeeds` with only `fetch` mocked, rather than
 * stubbing `lib/feed-sync.mjs`. That is not a style preference: Bun's
 * `mock.module` registry is keyed by specifier string and is process-global, so
 * one test file stubbing `'../lib/feed-sync.mjs'` silently replaces it for
 * every other test file that imports it under the same specifier — which is
 * every source. Tests written against a stub then pass without exercising any
 * of the dedupe, cursor, cap or deadline logic they appear to cover.
 *
 * Mocking `fetch` instead keeps each test honest and independent, and asserts
 * something better besides: that the URL a source builds is really requested.
 */

import { vi } from 'vitest';

/**
 * A minimal `fetch` Response carrying `text`, shaped for `fetchPage`: it
 * declares a Content-Length and streams the body through a single reader chunk.
 *
 * @param {string} text - the response body
 * @param {{ contentLength?: number }} [options] - override the declared length,
 *   to exercise the response-size cap without allocating a real payload
 * @returns {Response} the response, shaped for `fetchPage`
 */
export function okResponse(text, { contentLength } = {}) {
  const bytes = new TextEncoder().encode(text);
  // The sliver of `Response` `fetchPage` touches — `ok`, `headers`, and a body
  // that streams once. Building a real one would mean a real ReadableStream for
  // no gain; declaring the cast says which parts are honoured.
  return /** @type {Response} */ (
    /** @type {unknown} */ ({
      ok: true,
      headers: new Headers({ 'content-length': String(contentLength ?? bytes.length) }),
      body: {
        getReader() {
          let isDone = false;
          return {
            read() {
              if (isDone) return Promise.resolve({ done: true, value: undefined });
              isDone = true;
              return Promise.resolve({ done: false, value: bytes });
            },
            // A real reader's `cancel()` returns a promise, and the HTTP seam
            // awaits it when it abandons an over-cap body. Returning undefined
            // here made the fake fail on `.catch` instead.
            cancel() {
              return Promise.resolve();
            },
          };
        },
      },
    })
  );
}

/**
 * One RSS `<item>`; every field optional so a test can omit exactly one.
 *
 * @param {object} [fields] - What the item should carry.
 * @param {string} [fields.title] - Its `<title>`; `''` omits the element.
 * @param {string} [fields.link] - Its `<link>`; `''` omits the element.
 * @param {string} [fields.guid] - Its `<guid>`; defaults to the link.
 * @param {string} [fields.description] - Its CDATA `<description>`.
 * @param {string} [fields.date] - Its `<pubDate>`; `''` omits the element.
 * @param {string[]} [fields.categories] - One `<category>` each.
 * @param {string} [fields.extra] - Raw markup appended inside the item.
 * @returns {string} The `<item>` element.
 */
export function rssItemXml({
  title = 'Story',
  link = 'https://example.test/1',
  guid = '',
  description = 'Body',
  date = 'Mon, 15 Jan 2024 10:00:00 GMT',
  categories = [],
  extra = '',
} = {}) {
  const itemGuid = guid || link;
  return [
    '<item>',
    title ? `<title>${title}</title>` : '',
    link ? `<link>${link}</link>` : '',
    itemGuid ? `<guid>${itemGuid}</guid>` : '',
    description ? `<description><![CDATA[${description}]]></description>` : '',
    date ? `<pubDate>${date}</pubDate>` : '',
    ...categories.map((c) => `<category>${c}</category>`),
    extra,
    '</item>',
  ].join('');
}

/**
 * An RSS 2.0 document wrapping `items`.
 *
 * `channelTitle` is omitted by default: `parseRSS` falls back to it for an
 * item's author, which would otherwise shadow a source's `defaultAuthor` and
 * make those assertions test the fixture instead of the source. Pass one when
 * the channel title is the thing under test (podcast show attribution).
 *
 * @param {string[]} items - The `<item>` elements, already rendered.
 * @param {object} [options] - Channel-level fields.
 * @param {string} [options.channelTitle] - The channel's `<title>`.
 * @returns {string} The whole document.
 */
export function rssFeedXml(items, { channelTitle = '' } = {}) {
  const title = channelTitle ? `<title>${channelTitle}</title>` : '';
  return `<?xml version="1.0"?><rss version="2.0"><channel>${title}${items.join('')}</channel></rss>`;
}

/**
 * The URLs a mocked `fetch` was asked for, in call order.
 *
 * @param {import('vitest').Mock} fetchMock - The installed fetch mock.
 * @returns {string[]} Every requested URL.
 */
export function fetchedUrls(fetchMock) {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/**
 * A real {@link import('./types.d.ts').SyncContext} with spies on its sinks.
 *
 * Twenty-four test files each built their own, and all twenty-four were the
 * same four fields — `log.info`, `log.warn`, `progress`, `config` — with no
 * `credentials`, no `log.error`, and **no `deadline`**. That last one is not
 * cosmetic: `hasDeadlinePassed()` compares `Date.now()` against `context.deadline`,
 * so an absent deadline compares against `undefined` and is never reached. Every
 * soft-deadline branch in `syncFeeds` was unreachable in every one of those
 * files. The default here is thirty seconds out, which keeps that branch
 * dormant on purpose — a test that wants it passes `deadline` explicitly and
 * now actually gets it.
 *
 * @param {Partial<import('./types.d.ts').SyncContext>} [overrides] - Fields to replace.
 * @returns {import('./types.d.ts').SyncContext} A context a source can be run against.
 */
export function makeSyncContext(overrides = {}) {
  return {
    config: {},
    credentials: {},
    cursor: undefined,
    deadline: Date.now() + 30_000,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: vi.fn(),
    ...overrides,
  };
}

/**
 * Install a mocked `fetch`, returning the mock.
 *
 * `globalThis.fetch = vi.fn()` types the global as `typeof fetch`, so every
 * later `fetch.mockResolvedValue(...)` is an error on a property the global
 * does not have — and the assignment itself is an error too, since a bare mock
 * is not a `fetch`. One cast, in one place, instead of at every call site.
 *
 * @param {(url: string, init?: RequestInit) => unknown} [implementation] - What the
 *   mock should do. Typed as the sliver of `fetch` these tests call, so a stub
 *   reading the requested URL gets a string rather than an implicit `any`.
 * @returns {import('vitest').Mock} The installed mock.
 */
export function setFetch(implementation) {
  const mock = implementation ? vi.fn(implementation) : vi.fn();
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (mock));
  return mock;
}

/**
 * The currently-installed fetch mock, for a test that set it earlier.
 *
 * @returns {import('vitest').Mock} The mock now standing in for `fetch`.
 */
export function fetchMock() {
  return /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (globalThis.fetch));
}

/**
 * A {@link import('./types.d.ts').DirectoryContext} whose `fetch` answers with
 * `response`, and whose sinks are spies.
 *
 * The `fetch` is handed back as a `Mock` as well as the context's, so a test can
 * assert on the URL a provider built — which is most of what there is to check
 * about a provider that does no parsing of its own.
 *
 * @param {unknown} response - What every request resolves to.
 * @returns {import('./types.d.ts').DirectoryContext & { fetch: import('vitest').Mock }}
 *   The context.
 */
export function makeDirectoryContext(response) {
  /** @type {import('vitest').Mock} */
  const fetch = vi.fn(async () => response);
  return { fetch, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

/**
 * A complete {@link import('./types.d.ts').FeedItem} from the few fields a test
 * cares about.
 *
 * Every field on a parsed item is required — the parsers always set them, `''`
 * when the feed said nothing — so a bare `{ title, link }` object literal is not
 * one, and handing it to `feedItemDocument` types as an error rather than as the
 * shorthand it is meant to be. This fills in the rest.
 *
 * @param {Partial<import('./types.d.ts').FeedItem>} [fields] - What the test sets.
 * @returns {import('./types.d.ts').FeedItem} A whole item.
 */
export function makeFeedItem(fields = {}) {
  return {
    title: '',
    link: '',
    description: '',
    content: '',
    bodyHtml: '',
    pubDate: '',
    author: '',
    guid: '',
    categories: [],
    ...fields,
  };
}

/**
 * An item's enclosure, or a failure naming the item that carried none.
 *
 * `enclosure` is optional on a {@link import('./types.d.ts').FeedItem} because
 * most items have none. A test asserting on one has already said it expects the
 * parser to find it; this makes that expectation the thing that fails.
 *
 * @param {import('./types.d.ts').FeedItem} item - The parsed item.
 * @returns {import('./types.d.ts').FeedEnclosure} Its enclosure.
 */
export function enclosureOf(item) {
  if (!item.enclosure) {
    throw new Error(`expected an enclosure on "${item.title || item.link || 'the item'}"`);
  }
  return item.enclosure;
}

/**
 * The ISO instant of a date cursor, or a failure naming what came back instead.
 *
 * A cursor is a union, so `result.cursor.value` is only legal once the arm is
 * known. Asserting the arm here — rather than at every call site — says the
 * real thing when a source returns the wrong shape: a test that expected a date
 * cursor and got an idSet fails on that, not on a missing property.
 *
 * @param {import('./types.d.ts').Cursor | undefined} cursor - What `sync` returned.
 * @returns {string} The cursor's ISO value.
 */
export function dateCursorValue(cursor) {
  if (cursor?.type !== 'date') {
    throw new Error(`expected a date cursor, got ${JSON.stringify(cursor)}`);
  }
  return cursor.value;
}

/**
 * An idSet cursor, or a failure naming what came back instead.
 *
 * Returns the whole arm rather than just its ids: the cap travels with the set,
 * and a reader that wants to say whether the set is full needs both.
 *
 * @param {import('./types.d.ts').Cursor | undefined} cursor - What `sync` returned.
 * @returns {Extract<import('./types.d.ts').Cursor, { type: 'idSet' }>} The cursor.
 */
export function idSetCursor(cursor) {
  if (cursor?.type !== 'idSet') {
    throw new Error(`expected an idSet cursor, got ${JSON.stringify(cursor)}`);
  }
  return cursor;
}

/**
 * A context sink seen as the mock it is.
 *
 * {@link makeSyncContext} returns a real `SyncContext`, whose `log.warn` and
 * `progress` are declared as the plain functions a source calls — so a test
 * reaching for `.mock.calls` on one is reading a property the interface does
 * not have. This is that one cast, in one place.
 *
 * @param {(...args: never[]) => void} sink - `context.progress` or a `context.log` method.
 * @returns {import('vitest').Mock} The same function, as a mock.
 */
export function asMock(sink) {
  return /** @type {import('vitest').Mock} */ (/** @type {unknown} */ (sink));
}

/**
 * The entry at `index`, or a failure naming what was missing.
 *
 * `noUncheckedIndexedAccess` types `documents[0]` as possibly undefined, and it
 * is right to: a test asserting on `documents[0].title` when the source
 * returned nothing otherwise fails several lines later with "cannot read
 * property of undefined", pointing at the assertion rather than at the empty
 * result that caused it. This says the real thing.
 *
 * @template T
 * @param {readonly T[]} items - The array to read. Readonly because a cursor's
 *   `values` is, and reading an entry out of one never needed to mutate it.
 * @param {number} [index] - Which entry.
 * @returns {T} The entry, guaranteed present.
 */
export function at(items, index = 0) {
  const entry = items[index];
  if (entry === undefined) {
    throw new Error(`expected an entry at index ${index}, but the array has ${items.length}`);
  }
  return entry;
}
