import { describe, expect, it } from 'vitest';
import { at, enclosureOf } from './feed-fixtures.mjs';
import { parseRSS, xmlText } from './rss-parse.mjs';

describe('xmlText', () => {
  it('reads CDATA and plain-text bodies, treating tag names as literals', () => {
    expect(xmlText('<title><![CDATA[Hi & bye]]></title>', 'title')).toBe('Hi & bye');
    expect(xmlText('<dc:creator>Jane</dc:creator>', 'dc:creator')).toBe('Jane');
    expect(xmlText('<x>1</x>', 'missing')).toBe('');
  });
});

describe('parseRSS', () => {
  it('parses an RSS item with categories and a full content:encoded body', () => {
    const xml = `<rss><channel><item>
      <title>Post</title>
      <link>https://ex.test/p</link>
      <description><![CDATA[<p>Excerpt</p>]]></description>
      <content:encoded><![CDATA[<p>Full body</p>]]></content:encoded>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <category>Tech</category><category> News </category>
      <guid>g1</guid>
    </item></channel></rss>`;
    const item = at(parseRSS(xml));
    expect(item.title).toBe('Post');
    expect(item.link).toBe('https://ex.test/p');
    expect(item.description).toContain('Excerpt');
    expect(item.content).toBe('<p>Full body</p>');
    expect(item.categories).toEqual(['Tech', 'News']);
    expect(item.guid).toBe('g1');
  });

  it('parses an Atom entry, preferring the alternate link and the full content body', () => {
    const xml = `<feed><entry>
      <title>Entry</title>
      <link href="https://ex.test/self" rel="self"/>
      <link href="https://ex.test/a" rel="alternate"/>
      <summary><![CDATA[Short]]></summary>
      <content type="html"><![CDATA[<p>Long &amp; full</p>]]></content>
      <published>2024-01-01T00:00:00Z</published>
      <author><name>Jane</name></author>
      <id>tag:1</id>
    </entry></feed>`;
    const item = at(parseRSS(xml));
    expect(item.title).toBe('Entry');
    expect(item.link).toBe('https://ex.test/a');
    expect(item.description).toContain('Short');
    expect(item.content).toContain('Long & full');
    expect(item.author).toBe('Jane');
    expect(item.guid).toBe('tag:1');
  });
});

describe('attributed opening tags (Atom type="html")', () => {
  it('extracts a title carrying attributes — the jvns.ca live regression', () => {
    const xml = `<entry><title type="html">Moving away from Tailwind</title><link href="https://jvns.ca/x"/><updated>2026-05-14T00:00:00Z</updated><content type="html">body</content></entry>`;
    const items = parseRSS(xml);
    expect(items.length).toBe(1);
    expect(at(items, 0).title).toBe('Moving away from Tailwind');
  });

  it('does not let a tag prefix match a longer sibling tag', () => {
    const xml = `<entry><titleExtra>WRONG</titleExtra><title>Right</title><updated>2026-01-01T00:00:00Z</updated></entry>`;
    const items = parseRSS(xml);
    expect(at(items, 0).title).toBe('Right');
  });

  it('extracts attributed CDATA titles', () => {
    const xml = `<item><title type="text"><![CDATA[CDATA Title]]></title><link>https://x.example/a</link></item>`;
    const items = parseRSS(xml);
    expect(at(items, 0).title).toBe('CDATA Title');
  });
});

describe('namespace-prefixed Atom (the HBR live regression)', () => {
  it('parses entries whose every element carries a namespace prefix', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <ns6:feed xmlns:ns6="http://www.w3.org/2005/Atom">
        <ns6:title>HBR CMS</ns6:title>
        <ns6:entry>
          <ns6:title>The Hidden Storage Tax</ns6:title>
          <ns6:link href="https://hbr.org/2026/07/storage-tax" rel="alternate" type="text/html"/>
          <ns6:summary type="text">A short abstract.</ns6:summary>
          <ns6:published>2026-07-01T09:00:00Z</ns6:published>
          <ns6:id>tag:hbr.org,2026:storage-tax</ns6:id>
        </ns6:entry>
      </ns6:feed>`;
    const items = parseRSS(xml);
    expect(items.length).toBe(1);
    expect(at(items, 0).title).toBe('The Hidden Storage Tax');
    expect(at(items, 0).link).toBe('https://hbr.org/2026/07/storage-tax');
    expect(at(items, 0).description).toBe('A short abstract.');
    expect(at(items, 0).guid).toBe('tag:hbr.org,2026:storage-tax');
  });
});

describe('RSS 1.0 / RDF', () => {
  it('parses <rdf:RDF> documents where items sit beside the channel', () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel rdf:about="https://ex.test/"><title>Example Journal</title></channel>
      <item rdf:about="https://ex.test/one">
        <title>First</title>
        <link>https://ex.test/one</link>
        <description>Summary text</description>
        <dc:date>2026-01-05T00:00:00Z</dc:date>
        <dc:creator>Ada</dc:creator>
      </item>
    </rdf:RDF>`;
    const item = at(parseRSS(xml));
    expect(item.title).toBe('First');
    expect(item.link).toBe('https://ex.test/one');
    expect(item.pubDate).toBe('2026-01-05T00:00:00Z');
    expect(item.author).toBe('Ada');
  });
});

describe('JSON Feed', () => {
  it('parses JSON Feed 1.1 documents', () => {
    const json = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Daring Fireball',
      authors: [{ name: 'John Gruber' }],
      items: [
        {
          id: 'https://df.test/1',
          url: 'https://df.test/1',
          title: 'Hello',
          content_html: '<p>Full <em>body</em> here</p>',
          summary: 'Short.',
          date_published: '2026-07-11T19:43:35Z',
          tags: ['apple'],
        },
        { id: 2, content_text: 'Plain text body', date_modified: '2026-07-12T00:00:00Z' },
      ],
    });
    const items = parseRSS(json);
    expect(items.length).toBe(2);
    expect(at(items, 0).title).toBe('Hello');
    expect(at(items, 0).bodyHtml).toBe('<p>Full <em>body</em> here</p>');
    expect(at(items, 0).description).toBe('Short.');
    expect(at(items, 0).author).toBe('John Gruber');
    expect(at(items, 0).categories).toEqual(['apple']);
    expect(at(items, 1).guid).toBe('2');
    expect(at(items, 1).bodyHtml).toBe('Plain text body');
    expect(at(items, 1).pubDate).toBe('2026-07-12T00:00:00Z');
  });
});

describe('bodyHtml — the fullest available body', () => {
  it('prefers content:encoded, falling back to the raw description markup', () => {
    const withBoth = `<item><title>A</title><link>https://ex.test/a</link>
      <description><![CDATA[<p>Excerpt</p>]]></description>
      <content:encoded><![CDATA[<p>Everything</p>]]></content:encoded></item>`;
    expect(at(parseRSS(withBoth)).bodyHtml).toBe('<p>Everything</p>');

    const descriptionOnly = `<item><title>B</title><link>https://ex.test/b</link>
      <description>&lt;p&gt;Escaped full text&lt;/p&gt;</description></item>`;
    const item = at(parseRSS(descriptionOnly));
    expect(item.content).toBe('');
    expect(item.bodyHtml).toContain('Escaped full text');
  });

  it('unwraps CDATA separated from the opening tag by a newline (Daring Fireball)', () => {
    const xml = `<entry><title>DF</title><link href="https://df.test/x" rel="alternate"/>
      <summary type="text">Four word summary here.</summary>
      <content type="html" xml:base="https://df.test/">
      <![CDATA[ <p>The whole post body</p> ]]>
      </content><id>tag:df,1</id><published>2026-07-11T00:00:00Z</published></entry>`;
    const item = at(parseRSS(xml));
    expect(item.bodyHtml).toBe('<p>The whole post body</p>');
    expect(item.description).toBe('Four word summary here.');
  });
});

describe('author resolution', () => {
  it('falls back from missing entry authors to the feed-level author', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Julia Evans</title><author><name>Julia Evans</name></author>
      <entry><title>Post</title><link href="https://jvns.test/p"/><id>1</id></entry>
    </feed>`;
    expect(at(parseRSS(xml)).author).toBe('Julia Evans');
  });

  it('falls back to the feed title when no author exists anywhere', () => {
    const xml = `<rss><channel><title>Dan Luu</title>
      <item><title>Post</title><link>https://ex.test/p</link></item>
    </channel></rss>`;
    expect(at(parseRSS(xml)).author).toBe('Dan Luu');
  });

  it('extracts the display name from RSS email-style authors and never stores a bare email', () => {
    const withName = `<item><title>T</title><link>https://ex.test/t</link><author>news@ex.test (Johnny Dee)</author></item>`;
    expect(at(parseRSS(withName)).author).toBe('Johnny Dee');
    const bareEmail = `<item><title>T</title><link>https://ex.test/t</link><author>news@ex.test</author></item>`;
    expect(at(parseRSS(bareEmail)).author).toBe('');
  });
});

describe('categories', () => {
  it('collects Atom term attributes and de-duplicates', () => {
    const xml = `<entry><title>T</title><link href="https://ex.test/t"/><id>1</id>
      <category term="ai"/><category term="apple"/><category term="ai"/></entry>`;
    expect(at(parseRSS(xml)).categories).toEqual(['ai', 'apple']);
  });
});

describe('unrecognizable documents fail loudly', () => {
  it('throws on an HTML page instead of reporting a healthy zero-item feed', () => {
    const html = `<!DOCTYPE html><html><head><title>Blocked</title></head><body><p>403</p></body></html>`;
    expect(() => parseRSS(html)).toThrow(/Unrecognized feed format/);
  });

  it('throws on JSON that is not a JSON Feed', () => {
    expect(() => parseRSS('{"hello":"world"}')).toThrow(/Unrecognized feed format/);
  });

  it('still returns an empty list for a valid feed with no items', () => {
    expect(parseRSS('<rss><channel><title>Empty</title></channel></rss>')).toEqual([]);
  });

  // --- link blogs: whose page is `rel="alternate"`? ---
  //
  // On a link blog the entry's `alternate` is the article being pointed AT, and
  // the permalink for the post we actually stored is `rel="related"`. Reported
  // from the phone: tapping "open original" on a Daring Fireball post opened Six
  // Colors. 39 of that feed's 48 entries are this shape.
  const LINK_BLOG = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Daring Fireball</title>
      <link rel="alternate" type="text/html" href="https://daringfireball.net/" />
      <link rel="self" type="application/atom+xml" href="https://daringfireball.net/feeds/main" />
      <entry>
        <title>Apple Q3 2026 Results</title>
        <id>tag:daringfireball.net,2026:/linked//6.43312</id>
        <link rel="alternate" type="text/html" href="https://sixcolors.com/post/2026/07/apple-q3/" />
        <link rel="shorturl" type="text/html" href="http://df4.us/xf4" />
        <link rel="related" type="text/html" href="https://daringfireball.net/linked/2026/08/01/apple-q3" />
        <content type="html">Jason Snell:</content>
      </entry>
      <entry>
        <title>An Article Gruber Wrote Himself</title>
        <id>tag:daringfireball.net,2026:/feeds/main//6.43300</id>
        <link rel="alternate" type="text/html" href="https://daringfireball.net/2026/07/temu" />
        <content type="html">Body.</content>
      </entry>
    </feed>`;

  it('links a LINK-BLOG post to the publisher, not to the site it points at', () => {
    const linked = at(parseRSS(LINK_BLOG));
    expect(linked.link).toBe('https://daringfireball.net/linked/2026/08/01/apple-q3');
  });

  it('leaves the publisher’s OWN article alone', () => {
    // No `related` to prefer, and `alternate` is already on the publisher's
    // host — the rule must not fire here.
    expect(at(parseRSS(LINK_BLOG), 1).link).toBe('https://daringfireball.net/2026/07/temu');
  });

  it('does NOT change identity, so a corrected URL cannot duplicate a document', () => {
    // Identity comes from Atom `<id>`. If it came from the link, this fix would
    // re-ingest every linked-list post as a new document.
    expect(at(parseRSS(LINK_BLOG)).guid).toBe('tag:daringfireball.net,2026:/linked//6.43312');
  });

  it('keeps an off-site alternate when nothing points back to the publisher', () => {
    // An aggregator feed — every entry points out, and out is correct.
    const aggregator = `<feed xmlns="http://www.w3.org/2005/Atom">
        <link rel="alternate" type="text/html" href="https://news.example.com/" />
        <entry>
          <title>Elsewhere</title><id>x1</id>
          <link rel="alternate" type="text/html" href="https://other.example.org/story" />
        </entry>
      </feed>`;
    expect(at(parseRSS(aggregator)).link).toBe('https://other.example.org/story');
  });
});

describe('enclosures — how a podcast feed carries its audio', () => {
  it('reads url, type and length from an RSS <enclosure>', () => {
    const item = at(
      parseRSS(`<rss><channel><item>
      <title>Ep 1</title><link>https://show.test/1</link>
      <enclosure url="https://cdn.test/1.mp3" length="42000000" type="audio/mpeg"/>
    </item></channel></rss>`),
    );
    expect(item.enclosure).toEqual({
      url: 'https://cdn.test/1.mp3',
      type: 'audio/mpeg',
      length: 42_000_000,
    });
  });

  it('leaves enclosure undefined for an item without one', () => {
    const item = at(
      parseRSS(
        `<rss><channel><item><title>No audio</title><link>https://s.test/a</link></item></channel></rss>`,
      ),
    );
    expect(item.enclosure).toBeUndefined();
  });

  it('normalizes the type and drops a non-numeric length', () => {
    const item = at(
      parseRSS(`<rss><channel><item>
      <enclosure url="https://cdn.test/1.mp3" length="" type="Audio/MPEG; charset=binary"/>
    </item></channel></rss>`),
    );
    expect(enclosureOf(item).type).toBe('audio/mpeg');
    expect(enclosureOf(item).length).toBeUndefined();
  });

  it('takes the first enclosure when a feed repeats the element', () => {
    const item = at(
      parseRSS(`<rss><channel><item>
      <enclosure url="https://cdn.test/hi.mp3" type="audio/mpeg"/>
      <enclosure url="https://cdn.test/lo.mp3" type="audio/mpeg"/>
    </item></channel></rss>`),
    );
    expect(enclosureOf(item).url).toBe('https://cdn.test/hi.mp3');
  });

  it('reads an Atom <link rel="enclosure"> without mistaking it for the permalink', () => {
    const entry = at(
      parseRSS(`<feed><entry>
      <title>Ep 2</title>
      <link rel="alternate" href="https://show.test/2"/>
      <link rel="enclosure" type="audio/mpeg" length="99" href="https://cdn.test/2.mp3"/>
    </entry></feed>`),
    );
    expect(entry.link).toBe('https://show.test/2');
    expect(entry.enclosure).toEqual({
      url: 'https://cdn.test/2.mp3',
      type: 'audio/mpeg',
      length: 99,
    });
  });

  it('reads a JSON Feed attachment', () => {
    const item = at(
      parseRSS(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          items: [
            {
              id: '3',
              url: 'https://show.test/3',
              attachments: [
                { url: 'https://cdn.test/3.m4a', mime_type: 'audio/x-m4a', size_in_bytes: 7 },
              ],
            },
          ],
        }),
      ),
    );
    expect(item.enclosure).toEqual({
      url: 'https://cdn.test/3.m4a',
      type: 'audio/x-m4a',
      length: 7,
    });
  });
});

describe('feedTitle — the publication, distinct from the author', () => {
  it('carries the RSS channel title on every item', () => {
    const item = at(
      parseRSS(`<rss><channel>
      <title>The Test Show</title>
      <item><title>Ep 1</title><author>hosts@show.test (Ada and Grace)</author></item>
    </channel></rss>`),
    );
    expect(item.feedTitle).toBe('The Test Show');
    expect(item.author).toBe('Ada and Grace');
  });

  it('carries the Atom feed title', () => {
    const entry = at(
      parseRSS(`<feed><title>The Test Show</title><entry><title>Ep 1</title></entry></feed>`),
    );
    expect(entry.feedTitle).toBe('The Test Show');
  });

  it('carries the JSON Feed title', () => {
    const item = at(
      parseRSS(JSON.stringify({ version: '1.1', title: 'The Test Show', items: [{ id: '1' }] })),
    );
    expect(item.feedTitle).toBe('The Test Show');
  });

  it('is empty for a bare fragment with no feed element', () => {
    const item = at(parseRSS(`<item><title>Loose</title></item>`));
    expect(item.feedTitle).toBe('');
  });
});
