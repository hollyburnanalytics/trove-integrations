import { describe, expect, it } from 'bun:test';
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
    const [item] = parseRSS(xml);
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
    const [item] = parseRSS(xml);
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
    expect(items[0].title).toBe('Moving away from Tailwind');
  });

  it('does not let a tag prefix match a longer sibling tag', () => {
    const xml = `<entry><titleExtra>WRONG</titleExtra><title>Right</title><updated>2026-01-01T00:00:00Z</updated></entry>`;
    const items = parseRSS(xml);
    expect(items[0].title).toBe('Right');
  });

  it('extracts attributed CDATA titles', () => {
    const xml = `<item><title type="text"><![CDATA[CDATA Title]]></title><link>https://x.example/a</link></item>`;
    const items = parseRSS(xml);
    expect(items[0].title).toBe('CDATA Title');
  });
});
