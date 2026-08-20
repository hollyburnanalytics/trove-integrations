import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, makeSourceContext, okResponse, setFetch, syncOf } from '../lib/test-fixtures.mjs';
import extension, { PAGE_SIZE } from './index.mjs';

const sync = syncOf(extension);

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Stands in for `fetchPage` WITHOUT mocking the module. `mock.module` writes to
 * a process-global registry keyed by specifier, and mocking the `feeds.mjs`
 * barrel replaces the re-exported binding in `http.mjs` too — so stubbing
 * `fetchPage` here silently stubbed it for every other suite, whose feeds then
 * all "failed to fetch". Mocking `fetch` keeps the stub local to this file and
 * exercises the real fetchPage (SSRF guard, timeout, size cap) besides.
 *
 * The `fetchPage`-shaped API is preserved: configure bodies with
 * `.mockResolvedValue`/`.mockImplementation`, assert with `.toHaveBeenCalled*`
 * and `.mock.calls[i][0]` (the requested URL).
 */
const fetchPage = vi.fn();

/**
 * Route the source's fetches through the `fetchPage` spy.
 *
 * @returns {void} Nothing; it installs the mock.
 */
function installFetch() {
  setFetch(async (url) => okResponse(await fetchPage(String(url))));
}

/**
 * A context for this source.
 *
 * @param {Record<string, import('../lib/types.d.ts').ConfigValue>} [config] - Source config.
 * @param {import('../lib/types.d.ts').Cursor} [cursor] - The previous run's cursor.
 * @returns {import('../lib/types.d.ts').SourceContext} The context.
 */
const makeContext = (config = {}, cursor) => makeSourceContext({ config, cursor });

/**
 * One Atom `<entry>`.
 *
 * @param {string} id - The arXiv id.
 * @param {string} publishedIso - Its `<published>` instant.
 * @param {string} [title] - Its `<title>`.
 * @returns {string} The element.
 */
function entryXml(id, publishedIso, title = `Paper ${id}`) {
  return `<entry>
    <id>http://arxiv.org/abs/${id}</id>
    <title>${title}</title>
    <summary>Summary for ${id}.</summary>
    <published>${publishedIso}</published>
    <author><name>Alice Smith</name></author>
  </entry>`;
}

/**
 * An Atom feed wrapping `entries`.
 *
 * @param {string[]} entries - The rendered `<entry>` elements.
 * @returns {string} The document.
 */
function feedOf(entries) {
  return `<feed>${entries.join('\n')}</feed>`;
}

const ARXIV_RESPONSE = `<feed>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Test Paper on AI</title>
    <summary>This paper explores artificial intelligence.</summary>
    <published>2024-01-15T00:00:00Z</published>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
  </entry>
</feed>`;

describe('arxiv-papers source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('fetches papers with default queries', async () => {
    fetchPage.mockResolvedValue(ARXIV_RESPONSE);
    const result = await sync(makeContext());

    expect(fetchPage).toHaveBeenCalledTimes(2); // default 2 queries
    expect(result.documents.length).toBeGreaterThan(0);
    expect(at(result.documents, 0).title).toBe('Test Paper on AI');
    expect(at(result.documents, 0).author).toContain('Alice Smith');
    expect(at(result.documents, 0).author).toContain('Bob Jones');
  });

  it('uses configured queries', async () => {
    fetchPage.mockResolvedValue(ARXIV_RESPONSE);
    const result = await sync(makeContext({ queries: ['cat:cs.CL'] }));

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.documents.length).toBeGreaterThan(0);
  });

  it('handles fetch failure for a query gracefully', async () => {
    fetchPage.mockRejectedValue(new Error('Network error'));

    const context = makeContext({ queries: ['cat:cs.AI'] });
    const result = await sync(context);
    expect(context.log.warn).toHaveBeenCalled();
    expect(result.documents).toEqual([]);
  });

  it('truncates author list with et al for >3 authors', async () => {
    const xml = `<feed><entry>
      <id>http://arxiv.org/abs/2401.00001v1</id>
      <title>Multi-author Paper</title>
      <summary>Summary</summary>
      <published>2024-01-15T00:00:00Z</published>
      <author><name>A</name></author>
      <author><name>B</name></author>
      <author><name>C</name></author>
      <author><name>D</name></author>
    </entry></feed>`;
    fetchPage.mockResolvedValue(xml);

    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
    expect(at(result.documents, 0).author).toContain('et al.');
  });

  it('returns correct stats and a date cursor at the newest paper', async () => {
    fetchPage.mockResolvedValue(ARXIV_RESPONSE);
    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
    expect(result.stats?.fetched).toBe(result.documents.length);
    expect(result.cursor).toEqual({ type: 'date', value: '2024-01-15T00:00:00.000Z' });
  });

  it('handles entries with missing published date', async () => {
    const xml = `<feed><entry>
      <id>http://arxiv.org/abs/2401.00001v1</id>
      <title>Paper</title>
      <summary>Summary</summary>
      <author><name>Author</name></author>
    </entry></feed>`;
    fetchPage.mockResolvedValue(xml);

    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
    // No submission date from arXiv means no date — never the sync time, which
    // would date a decade-old paper as brand new.
    expect(result.documents).toHaveLength(1);
    expect(at(result.documents, 0).date).toBeUndefined();
  });

  it('handles entries with missing tags', async () => {
    const xml = `<feed><entry>
      <id>http://arxiv.org/abs/2401.00001v1</id>
      <published>2024-01-15T00:00:00Z</published>
    </entry></feed>`;
    fetchPage.mockResolvedValue(xml);

    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
    expect(at(result.documents, 0).title).toBe('');
    expect(at(result.documents, 0).author).toBe('');
  });

  it('handles <=3 authors without et al', async () => {
    const xml = `<feed><entry>
      <id>http://arxiv.org/abs/2401.00001v1</id>
      <title>Paper</title>
      <summary>Summary</summary>
      <published>2024-01-15T00:00:00Z</published>
      <author><name>Alice</name></author>
      <author><name>Bob</name></author>
      <author><name>Charlie</name></author>
    </entry></feed>`;
    fetchPage.mockResolvedValue(xml);

    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
    expect(at(result.documents, 0).author).toBe('Alice, Bob, Charlie');
    expect(at(result.documents, 0).author).not.toContain('et al');
  });

  it('emits a paper matching multiple queries only once', async () => {
    // The same entry comes back for both default queries (cs.AI and cs.LG).
    fetchPage.mockResolvedValue(ARXIV_RESPONSE);
    const result = await sync(makeContext());

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.documents).toHaveLength(1);
    expect(at(result.documents, 0).id).toBe('arxiv-2401.00001v1');
  });

  it('filters papers by the date cursor and advances it', async () => {
    fetchPage.mockResolvedValue(
      feedOf([
        entryXml('2401.00002v1', '2024-01-15T00:00:00Z', 'New Paper'),
        entryXml('2401.00001v1', '2024-01-05T00:00:00Z', 'Old Paper'),
      ]),
    );

    const result = await sync(
      makeContext({ queries: ['cat:cs.AI'] }, { type: 'date', value: '2024-01-10T00:00:00.000Z' }),
    );

    expect(result.documents.map((d) => d.title)).toEqual(['New Paper']);
    expect(result.cursor).toEqual({ type: 'date', value: '2024-01-15T00:00:00.000Z' });
  });

  it('paginates through full pages until a short page', async () => {
    // Page 0 is exactly PAGE_SIZE entries -> there may be more; page 1 is
    // short -> done. Previously max_results=20 with no paging silently lost
    // everything beyond the first 20 results.
    const fullPage = feedOf(
      Array.from({ length: PAGE_SIZE }, (_, index) =>
        entryXml(`2401.1${String(index).padStart(4, '0')}v1`, '2024-01-15T00:00:00Z'),
      ),
    );
    const shortPage = feedOf([entryXml('2401.99999v1', '2024-01-14T00:00:00Z')]);
    fetchPage.mockImplementation((url) =>
      Promise.resolve(url.includes('start=0') ? fullPage : shortPage),
    );

    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(String(fetchPage.mock.calls[0]?.[0])).toContain('start=0');
    expect(String(fetchPage.mock.calls[1]?.[0])).toContain(`start=${PAGE_SIZE}`);
    expect(result.documents).toHaveLength(PAGE_SIZE + 1);
  });

  it('stops paging a query once entries fall behind the cursor', async () => {
    // Results are sorted newest-first; the first stale entry means everything
    // after it is older — no further pages are fetched.
    const fullStalePage = feedOf(
      Array.from({ length: PAGE_SIZE }, (_, index) =>
        entryXml(`2312.2${String(index).padStart(4, '0')}v1`, '2023-12-01T00:00:00Z'),
      ),
    );
    fetchPage.mockResolvedValue(fullStalePage);

    const result = await sync(
      makeContext({ queries: ['cat:cs.AI'] }, { type: 'date', value: '2024-01-10T00:00:00.000Z' }),
    );

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.documents).toEqual([]);
  });

  it('holds the cursor when a query fails (others still return papers)', async () => {
    fetchPage.mockImplementation((url) =>
      url.includes(encodeURIComponent('cat:cs.LG'))
        ? Promise.reject(new Error('arXiv down'))
        : Promise.resolve(feedOf([entryXml('2401.00002v1', '2024-01-15T00:00:00Z')])),
    );

    /** @type {import('../lib/types.d.ts').Cursor} */
    const cursor = { type: 'date', value: '2024-01-01T00:00:00.000Z' };
    const result = await sync(makeContext({ queries: ['cat:cs.AI', 'cat:cs.LG'] }, cursor));

    expect(result.documents).toHaveLength(1);
    // The failed query's unseen papers must stay reachable next run.
    expect(result.cursor).toEqual(cursor);
  });

  it('decodes entity-encoded titles and abstracts', async () => {
    fetchPage.mockResolvedValue(
      feedOf([entryXml('2606.00001v1', '2026-06-01T00:00:00Z', 'Atlas H&amp;E-TME: P &lt; NP')]),
    );

    const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
    expect(at(result.documents, 0).title).toBe('Atlas H&E-TME: P < NP');
    expect(at(result.documents, 0).text).not.toContain('&amp;');
  });
});

/**
 * Sync one Atom entry and return the document it produced.
 *
 * @param {string} xml - The `<entry>` element.
 * @returns {Promise<import('../lib/types.d.ts').Document>} The document.
 */
async function firstDocument(xml) {
  setFetch(async () => new Response(`<feed>${xml}</feed>`));
  const result = await sync(makeContext({ queries: ['cat:cs.AI'] }));
  return at(result.documents);
}

describe('arxiv stores the paper, not just its abstract', () => {
  /** One Atom entry, the shape arXiv's API returns. */
  const ENTRY = `<entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>A Paper About Things</title>
    <summary>We show that things are indeed things.</summary>
    <published>2026-01-15T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
  </entry>`;

  it('points at the LaTeXML HTML, whose maths survives as LaTeX', async () => {
    const document = await firstDocument(ENTRY);
    // A PDF turns an equation into glyph soup and welds two-column paragraphs;
    // the HTML carries each formula's LaTeX in `alttext`, which the server
    // renders as readable `$…$`.
    expect(document?.fileUrl).toBe('https://arxiv.org/html/2401.12345v1');
    expect(document?.mimeType).toBe('text/html');
  });

  it('falls back to the PDF for papers that predate LaTeXML', async () => {
    const document = await firstDocument(ENTRY);
    expect(document?.fallback).toEqual({
      fileUrl: 'https://arxiv.org/pdf/2401.12345v1',
      mimeType: 'application/pdf',
    });
  });

  it('keeps the abstract as the body, so a paper neither covers still reads', async () => {
    const document = await firstDocument(ENTRY);
    expect(document?.text).toContain('We show that things are indeed things.');
    expect(document?.title).toBe('A Paper About Things');
  });
});
