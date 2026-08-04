/**
 * Test fixtures for feed source adapters.
 *
 * Source tests drive the REAL `syncFeeds` with only `fetch` mocked, rather than
 * stubbing `lib/feed-sync.mjs`. That is not a style preference: Bun's
 * `mock.module` registry is keyed by specifier string and is process-global, so
 * one test file stubbing `'../../lib/feed-sync.mjs'` silently replaces it for
 * every other test file that imports it under the same specifier — which is
 * every source. Tests written against a stub then pass without exercising any
 * of the dedupe, watermark, cap or deadline logic they appear to cover.
 *
 * Mocking `fetch` instead keeps each test honest and independent, and asserts
 * something better besides: that the URL a source builds is really requested.
 */

/**
 * A minimal `fetch` Response carrying `text`, shaped for `fetchPage`: it
 * declares a Content-Length and streams the body through a single reader chunk.
 *
 * @param {string} text - the response body
 * @param {{ contentLength?: number }} [options] - override the declared length,
 *   to exercise the response-size cap without allocating a real payload
 */
export function okResponse(text, { contentLength } = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    headers: new Headers({ 'content-length': String(contentLength ?? bytes.length) }),
    body: {
      getReader() {
        let done = false;
        return {
          read() {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: bytes });
          },
          cancel() {},
        };
      },
    },
  };
}

/** One RSS `<item>`; every field optional so a test can omit exactly one. */
export function rssItemXml({
  title = 'Story',
  link = 'https://example.test/1',
  guid = link,
  description = 'Body',
  date = 'Mon, 15 Jan 2024 10:00:00 GMT',
  categories = [],
  extra = '',
} = {}) {
  return [
    '<item>',
    title ? `<title>${title}</title>` : '',
    link ? `<link>${link}</link>` : '',
    guid ? `<guid>${guid}</guid>` : '',
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
 */
export function rssFeedXml(items, { channelTitle = '' } = {}) {
  const title = channelTitle ? `<title>${channelTitle}</title>` : '';
  return `<?xml version="1.0"?><rss version="2.0"><channel>${title}${items.join('')}</channel></rss>`;
}

/** The URLs a mocked `fetch` was asked for, in call order. */
export function fetchedUrls(fetchMock) {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}
