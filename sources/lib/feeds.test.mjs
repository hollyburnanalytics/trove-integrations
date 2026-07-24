import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import {
  decodeHtmlEntities,
  fetchArticleText,
  fetchPage,
  htmlToText,
  parseRSS,
  safeDate,
  stableId,
  syncFeedArticles,
  syncRSS,
  xmlText,
} from './feeds.mjs';

// --- Shared test helpers ---

function mockFetch(xml) {
  const encoded = new TextEncoder().encode(xml);
  fetch.mockResolvedValue({
    ok: true,
    headers: new Headers(),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () => {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: encoded });
          },
        };
      },
    },
  });
}

function makeContext(cursor) {
  return {
    log: { info: mock(), warn: mock() },
    progress: mock(),
    config: {},
    cursor,
  };
}

// --- stableId ---

describe('stableId', () => {
  it('produces consistent IDs for the same input', () => {
    const a = stableId('test', 'https://example.com/post-1');
    const b = stableId('test', 'https://example.com/post-1');
    expect(a).toBe(b);
  });

  it('produces different IDs for different inputs', () => {
    const a = stableId('test', 'https://example.com/post-1');
    const b = stableId('test', 'https://example.com/post-2');
    expect(a).not.toBe(b);
  });

  it('includes the prefix', () => {
    const id = stableId('blog', 'https://example.com/post');
    expect(id).toMatch(/^blog-/);
  });
});

// --- safeDate ---

describe('safeDate', () => {
  it('returns ISO string for valid date', () => {
    const result = safeDate('2024-01-15');
    expect(result).toBe(new Date('2024-01-15').toISOString());
  });

  it('returns null for empty input', () => {
    expect(safeDate()).toBeUndefined();
    expect(safeDate()).toBeUndefined();
    expect(safeDate('')).toBeUndefined();
  });

  it('returns null for invalid date', () => {
    expect(safeDate('not-a-date')).toBeUndefined();
  });
});

// --- xmlText ---

describe('xmlText', () => {
  it('extracts plain text content', () => {
    expect(xmlText('<title>Hello World</title>', 'title')).toBe('Hello World');
  });

  it('extracts CDATA content', () => {
    expect(xmlText('<title><![CDATA[Hello World]]></title>', 'title')).toBe('Hello World');
  });

  it('returns empty string for missing tag', () => {
    expect(xmlText('<foo>bar</foo>', 'title')).toBe('');
  });

  it('trims whitespace', () => {
    expect(xmlText('<title>  Hello  </title>', 'title')).toBe('Hello');
  });

  it('handles tags with special regex characters', () => {
    expect(xmlText('<dc:creator>Author</dc:creator>', 'dc:creator')).toBe('Author');
  });
});

// --- parseRSS ---

describe('parseRSS', () => {
  it('parses RSS 2.0 items', () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        <item>
          <title>Post One</title>
          <link>https://example.com/post-1</link>
          <description>First post</description>
          <pubDate>Mon, 15 Jan 2024 00:00:00 GMT</pubDate>
          <guid>post-1</guid>
        </item>
      </channel>
    </rss>`;

    const items = parseRSS(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Post One');
    expect(items[0].link).toBe('https://example.com/post-1');
    expect(items[0].description).toBe('First post');
    expect(items[0].pubDate).toBe('Mon, 15 Jan 2024 00:00:00 GMT');
    expect(items[0].guid).toBe('post-1');
  });

  it('parses RSS item with dc:creator author', () => {
    const xml = `<item>
      <title>Test</title>
      <link>https://example.com</link>
      <description>Desc</description>
      <dc:creator>John Doe</dc:creator>
    </item>`;
    const items = parseRSS(xml);
    expect(items[0].author).toBe('John Doe');
  });

  it('parses Atom entries', () => {
    const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Test Feed</title>
      <entry>
        <title>Atom Post</title>
        <link href="https://example.com/atom-1" rel="alternate"/>
        <summary>An atom entry</summary>
        <published>2024-01-15T00:00:00Z</published>
        <id>atom-1</id>
        <author><name>Author Name</name></author>
      </entry>
    </feed>`;

    const items = parseRSS(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Atom Post');
    expect(items[0].link).toBe('https://example.com/atom-1');
    expect(items[0].pubDate).toBe('2024-01-15T00:00:00Z');
    expect(items[0].guid).toBe('atom-1');
    expect(items[0].author).toBe('Author Name');
  });

  it('parses Atom with reverse attribute order on link', () => {
    const xml = `<entry>
      <title>Test</title>
      <link rel="alternate" href="https://example.com/test"/>
      <summary>Summary</summary>
      <id>test-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].link).toBe('https://example.com/test');
  });

  it('uses a self-closing <link href> when no rel="alternate" is present (sources-2)', () => {
    // Many Atom feeds emit a single <link href="..."/> with no rel attribute;
    // the alternate-specific regexes miss it, so a plain href fallback is needed.
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Bare Href Post</title>
        <link href="https://example.com/atom-bare"/>
        <summary>S</summary>
        <id>bare-1</id>
      </entry>
    </feed>`;
    const items = parseRSS(xml);
    expect(items[0].link).toBe('https://example.com/atom-bare');
    expect(items[0].guid).toBe('bare-1');
  });

  it('prefers the rel="alternate" link over other <link> elements', () => {
    // A self/edit link precedes the alternate; the alternate must win.
    const xml = `<entry>
      <title>Multi-link</title>
      <link rel="self" href="https://example.com/feed/self"/>
      <link rel="alternate" href="https://example.com/the-post"/>
      <id>m-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].link).toBe('https://example.com/the-post');
  });

  it('falls back to a bare <link> element and uses link as guid when <id> is absent', () => {
    // No href/rel="alternate" attribute and no <id>: both fall back to the
    // element text of <link>.
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Bare Link Post</title>
        <link>https://example.com/bare</link>
        <summary>Summary</summary>
      </entry>
    </feed>`;
    const items = parseRSS(xml);
    expect(items[0].link).toBe('https://example.com/bare');
    expect(items[0].guid).toBe('https://example.com/bare');
  });

  it('decodes HTML entities in Atom content', () => {
    const xml = `<entry>
      <title>Test</title>
      <link href="https://example.com" rel="alternate"/>
      <summary>&lt;p&gt;Hello &amp; World&lt;/p&gt;</summary>
      <id>test-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].description).toBe('Hello & World');
  });

  it('decodes numeric entities in Atom content', () => {
    const xml = `<entry>
      <title>Test</title>
      <link href="https://example.com" rel="alternate"/>
      <summary>&#39;quoted&#39; &#x26; hex</summary>
      <id>test-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].description).toContain("'quoted'");
    expect(items[0].description).toContain('& hex');
  });

  it('uses content tag as fallback for Atom summary', () => {
    const xml = `<entry>
      <title>Test</title>
      <link href="https://example.com" rel="alternate"/>
      <content>Atom content here</content>
      <id>test-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].description).toBe('Atom content here');
  });

  it('truncates Atom description to 1000 chars', () => {
    const longText = 'A'.repeat(2000);
    const xml = `<entry>
      <title>Test</title>
      <link href="https://example.com" rel="alternate"/>
      <summary>${longText}</summary>
      <id>test-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].description.length).toBe(1000);
  });

  it('uses updated date as fallback for Atom published', () => {
    const xml = `<entry>
      <title>Test</title>
      <link href="https://example.com" rel="alternate"/>
      <summary>Summary</summary>
      <updated>2024-02-01T00:00:00Z</updated>
      <id>test-1</id>
    </entry>`;
    const items = parseRSS(xml);
    expect(items[0].pubDate).toBe('2024-02-01T00:00:00Z');
  });

  it('throws on non-feed XML — a misconfigured feed must fail loudly, not sync zero forever', () => {
    expect(() => parseRSS('<html><body>Not a feed</body></html>')).toThrow(
      /Unrecognized feed format/,
    );
  });
});

// --- fetchPage ---

describe('fetchPage', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches and returns text content', async () => {
    const content = 'Hello World';
    const encoder = new TextEncoder();
    const encoded = encoder.encode(content);

    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(encoded.length) }),
      body: {
        getReader: () => {
          let done = false;
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: encoded });
            },
            cancel: mock(),
          };
        },
      },
    });

    const result = await fetchPage('https://example.com');
    expect(result).toBe('Hello World');
  });

  it('throws on non-OK response', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchPage('https://example.com')).rejects.toThrow('HTTP 404');
  });

  it('rejects private/loopback/non-HTTP hosts before fetching (SSRF guard)', async () => {
    // Scheme assembled inline to keep sonarjs/no-clear-text-protocols off these fixtures.
    const blocked = [
      '169.254.169.254/latest/meta-data/', // cloud metadata
      'localhost:8080/',
      '127.0.0.1/',
      '10.0.0.1/',
      '192.168.1.1/',
      '172.16.0.1/',
      '[::1]/',
      'service.internal/',
    ].map((host) => `${'http'}://${host}`);
    blocked.push('file:///etc/passwd', 'not a url');
    for (const url of blocked) {
      await expect(fetchPage(url)).rejects.toThrow(/Refusing|Invalid URL/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws on content-length too large', async () => {
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '999999999' }),
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
    });
    await expect(fetchPage('https://example.com')).rejects.toThrow('Response too large');
  });

  it('throws on streaming content exceeding limit', async () => {
    const bigChunk = new Uint8Array(11 * 1024 * 1024);
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => {
          let done = false;
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: bigChunk });
            },
            cancel: mock(),
          };
        },
      },
    });
    await expect(fetchPage('https://example.com')).rejects.toThrow('exceeded');
  });

  it('passes an abort signal so a slow request can be timed out', async () => {
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
    });
    await fetchPage('https://example.com');
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});

// --- syncRSS ---

describe('syncRSS', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('decodes entity-encoded titles and converts descriptions (lenny regression)', async () => {
    mockFetch(`<rss><channel><item>
      <title>Watch now | &#127897;&#65039; Testing Google&#8217;s Gemini</title>
      <link>https://example.com/ep</link>
      <description>&lt;p&gt;Episode &amp;amp; notes&lt;/p&gt;</description>
      <pubDate>Mon, 15 Jan 2024 00:00:00 GMT</pubDate>
      <guid>ep-1</guid>
    </item></channel></rss>`);

    const result = await syncRSS(makeContext(), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Author',
    });

    const document = result.documents[0];
    expect(document.title).toBe('Watch now | \u{1F399}\uFE0F Testing Google\u2019s Gemini');
    expect(document.text).not.toMatch(/&#\d+;|&[a-z]+;|<[a-z]/);
    expect(document.text).toContain('Episode & notes');
  });

  it('fetches and parses RSS feed', async () => {
    const xml = `<rss><channel><item>
      <title>Post</title>
      <link>https://example.com/1</link>
      <description>Desc</description>
      <pubDate>Mon, 15 Jan 2024 00:00:00 GMT</pubDate>
      <guid>1</guid>
    </item></channel></rss>`;
    mockFetch(xml);

    const result = await syncRSS(makeContext(), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Author',
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toBe('Post');
    expect(result.documents[0].author).toBe('Author');
    expect(result.stats.fetched).toBe(1);
    expect(result.cursor).toEqual({ type: 'date', value: '2024-01-15T00:00:00.000Z' });
  });

  it('filters items by cursor date', async () => {
    const xml = `<rss><channel>
      <item><title>Old</title><link>https://example.com/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><guid>old</guid></item>
      <item><title>New</title><link>https://example.com/new</link><pubDate>Wed, 20 Mar 2024 00:00:00 GMT</pubDate><guid>new</guid></item>
    </channel></rss>`;
    mockFetch(xml);

    const result = await syncRSS(makeContext({ type: 'date', value: '2024-02-01T00:00:00.000Z' }), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Author',
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].title).toBe('New');
    expect(result.stats.skipped).toBe(1);
  });

  it('includes items with no date when cursor is set', async () => {
    const xml = `<rss><channel>
      <item><title>No Date</title><link>https://example.com/no-date</link><guid>nd</guid></item>
    </channel></rss>`;
    mockFetch(xml);

    const result = await syncRSS(makeContext({ type: 'date', value: '2024-02-01T00:00:00.000Z' }), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Author',
    });

    expect(result.documents).toHaveLength(1);
  });

  it('preserves cursor when no new dates', async () => {
    const xml = `<rss><channel>
      <item><title>No Date</title><link>https://example.com/1</link><guid>1</guid></item>
    </channel></rss>`;
    mockFetch(xml);

    const cursor = { type: 'date', value: '2024-01-01T00:00:00.000Z' };
    const result = await syncRSS(makeContext(cursor), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Author',
    });

    expect(result.cursor).toEqual(cursor);
  });

  it('uses Untitled for items without title', async () => {
    const xml = `<rss><channel><item>
      <link>https://example.com/1</link>
      <description>Desc</description><guid>1</guid>
    </item></channel></rss>`;
    mockFetch(xml);

    const result = await syncRSS(makeContext(), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Author',
    });

    expect(result.documents[0].title).toBe('Untitled');
  });

  it('uses item author over defaultAuthor', async () => {
    const xml = `<rss><channel><item>
      <title>Post</title><link>https://example.com/1</link>
      <dc:creator>Item Author</dc:creator><guid>1</guid>
    </item></channel></rss>`;
    mockFetch(xml);

    const result = await syncRSS(makeContext(), {
      feedUrl: 'https://example.com/feed',
      idPrefix: 'test',
      defaultAuthor: 'Default',
    });

    expect(result.documents[0].author).toBe('Item Author');
  });
});

// --- decodeHtmlEntities ---
describe('decodeHtmlEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeHtmlEntities('A &amp; B &lt;c&gt; &#39;q&#39; &#x2F;')).toBe("A & B <c> 'q' /");
  });
  it('leaves plain text unchanged', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });
});

// --- htmlToText ---
describe('htmlToText', () => {
  it('strips tags and decodes entities to plain text', () => {
    expect(htmlToText('<p>Hello <strong>world</strong> &amp; friends</p>')).toBe(
      'Hello world & friends',
    );
  });
  it('fences a pre block and strips highlighting markup', () => {
    const html = `<pre><code><span class="pl-k">const</span> x = <span class="pl-c1">1</span></code></pre>`;
    expect(htmlToText(html)).toBe('```\nconst x = 1\n```');
  });
  it('wraps inline code in backticks so it renders as a chip', () => {
    expect(htmlToText('<p>Run <code>npm test</code> now</p>')).toBe('Run `npm test` now');
  });
  it('preserves line breaks but caps blank runs', () => {
    expect(htmlToText('a\n\n\n\nb')).toBe('a\n\nb');
  });
  it('returns empty string for falsy input', () => {
    expect(htmlToText('')).toBe('');
  });
  it('keeps paragraph boundaries as blank lines', () => {
    expect(htmlToText('<p>One.</p><p>Two.</p>')).toBe('One.\n\nTwo.');
  });
  it('renders list items on their own lines', () => {
    expect(htmlToText('<ul><li>First</li><li>Second</li></ul>')).toBe('- First\n- Second');
  });
  it('preserves line breaks inside a fenced pre block', () => {
    const html = '<p>Before</p><pre><code>line1\nline2</code></pre>';
    expect(htmlToText(html)).toBe('Before\n\n```\nline1\nline2\n```');
  });
  it('drops script and style content entirely', () => {
    expect(htmlToText('<p>Keep</p><script>var x=1;</script><style>.a{}</style>')).toBe('Keep');
  });
  it('reduces images to their alt text', () => {
    expect(htmlToText('<p>Portrait: <img src="x.jpg" alt="Om Malik holding a camera"/></p>')).toBe(
      'Portrait: [Image: Om Malik holding a camera]',
    );
  });
  it('parses entity-escaped markup instead of leaking literal tags', () => {
    expect(htmlToText('&lt;p&gt;Escaped &amp;amp; decoded&lt;/p&gt;')).toBe('Escaped & decoded');
  });
  it('decodes common named entities', () => {
    expect(htmlToText('<p>a&nbsp;&mdash;&nbsp;b&hellip;</p>')).toBe('a — b…');
  });
});

// --- fetchArticleText + syncFeedArticles (full-text fetch for CC sources) ---

function streamBody(text) {
  const encoded = new TextEncoder().encode(text);
  return {
    ok: true,
    headers: new Headers(),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () => {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: encoded });
          },
        };
      },
    },
  };
}

const FAIL_500 = Symbol('fail-500');
function mockFetchByUrl(map) {
  fetch.mockImplementation((url) => {
    for (const [fragment, body] of Object.entries(map)) {
      if (String(url).includes(fragment)) {
        return body === FAIL_500
          ? Promise.resolve({ ok: false, status: 500 })
          : Promise.resolve(streamBody(body));
      }
    }
    return Promise.resolve(streamBody('<html></html>'));
  });
}

const ARTICLE_HTML =
  '<html><body><nav>Menu</nav><article class="post"><p>The full article body goes here.</p></article><footer>Footer</footer></body></html>';
const ARTICLE_FEED = `<rss><channel>
  <item><title>Old</title><link>https://site/old</link><description>old excerpt</description>
    <pubDate>Mon, 01 Jan 2020 00:00:00 GMT</pubDate><guid>old</guid></item>
  <item><title>New</title><link>https://site/new</link><description>new excerpt</description>
    <pubDate>Wed, 10 Jan 2024 00:00:00 GMT</pubDate><guid>new</guid></item>
</channel></rss>`;

describe('fetchArticleText', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => jest.restoreAllMocks());

  it('extracts only the selected container, dropping chrome', async () => {
    mockFetchByUrl({ 'x.test': ARTICLE_HTML });
    const text = await fetchArticleText('https://x.test/a', 'article.post');
    expect(text).toBe('The full article body goes here.');
    expect(text).not.toContain('Menu');
    expect(text).not.toContain('Footer');
  });

  it('falls back to <main>/<article> when the selector matches nothing', async () => {
    mockFetchByUrl({ 'x.test': '<html><body><main><p>Main body.</p></main></body></html>' });
    const text = await fetchArticleText('https://x.test/a', '.does-not-exist');
    expect(text).toContain('Main body');
  });
});

describe('syncFeedArticles', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });
  afterEach(() => jest.restoreAllMocks());

  const options = {
    feedUrl: 'https://site/feed',
    idPrefix: 't',
    defaultAuthor: 'T',
    articleSelector: 'article.post',
    delayMs: 0,
  };

  it('fetches each new article and stores its full text', async () => {
    mockFetchByUrl({ '/feed': ARTICLE_FEED, '/new': ARTICLE_HTML, '/old': ARTICLE_HTML });
    const result = await syncFeedArticles(makeContext(), options);
    expect(result.documents).toHaveLength(2);
    expect(result.documents.every((d) => d.text.includes('The full article body'))).toBe(true);
    expect(result.cursor).toEqual({ type: 'date', value: '2024-01-10T00:00:00.000Z' });
  });

  it('skips items at or before the date watermark', async () => {
    mockFetchByUrl({ '/feed': ARTICLE_FEED, '/new': ARTICLE_HTML });
    const result = await syncFeedArticles(
      makeContext({ type: 'date', value: '2023-01-01T00:00:00.000Z' }),
      options,
    );
    expect(result.documents.map((d) => d.title)).toEqual(['New']);
  });

  it('falls back to the excerpt when an article fetch fails', async () => {
    mockFetchByUrl({ '/feed': ARTICLE_FEED, '/new': FAIL_500, '/old': FAIL_500 });
    const context = makeContext();
    const result = await syncFeedArticles(context, options);
    expect(result.documents).toHaveLength(2);
    expect(result.documents.every((d) => d.text.includes('excerpt'))).toBe(true);
    expect(context.log.warn).toHaveBeenCalled();
  });

  it('stops at the time budget and reports the remainder', async () => {
    mockFetchByUrl({ '/feed': ARTICLE_FEED, '/new': ARTICLE_HTML, '/old': ARTICLE_HTML });
    const context = makeContext();
    context.deadline = Date.now() - 1;
    const result = await syncFeedArticles(context, options);
    expect(result.documents).toHaveLength(0);
    expect(result.stats.remaining).toBeGreaterThan(0);
  });
});
