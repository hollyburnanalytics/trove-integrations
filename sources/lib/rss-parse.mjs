/**
 * RSS/Atom parsing for feed source adapters: extract tag text/HTML from XML
 * fragments and parse a feed into a normalized list of items. Handles both RSS
 * (`<item>`) and Atom (`<entry>`) shapes.
 */

import { decodeHtmlEntities, stripHtmlTags } from './text.mjs';

/**
 * Extract a tag's text content from an XML fragment.
 * Handles CDATA and plain text. Tag names are treated as literals, not regex.
 */
export function xmlText(xml, tag) {
  const t = tag.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // Tolerate attributes on the opening tag — Atom feeds commonly emit
  // `<title type="html">…` (jvns.ca shipped 20/20 items as "Untitled" live
  // because this matched only the bare tag). The `(?:\s[^>]*)?` boundary
  // keeps `<title` from matching a longer sibling tag name.
  const m =
    xml.match(new RegExp(String.raw`<${t}(?:\s[^>]*)?><!\[CDATA\[([\s\S]*?)\]\]><\/${t}>`)) ||
    xml.match(new RegExp(String.raw`<${t}(?:\s[^>]*)?>([^<]*)<\/${t}>`));
  return m ? m[1].trim() : '';
}

/**
 * Extract a tag's full inner content (including HTML) from an XML fragment.
 */
function xmlHtml(xml, tag) {
  const t = tag.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const m =
    xml.match(new RegExp(String.raw`<${t}[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/${t}>`)) ||
    xml.match(new RegExp(String.raw`<${t}[^>]*>([\s\S]*?)<\/${t}>`));
  return m ? m[1].trim() : '';
}

/**
 * Parse RSS/Atom XML into items.
 * Handles both RSS (<item>) and Atom (<entry>) feeds.
 */
export function parseRSS(xml) {
  const items = [];

  // Try RSS <item> first
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    items.push({
      title: xmlText(x, 'title'),
      link: xmlText(x, 'link'),
      description: stripHtmlTags(xmlText(x, 'description')),
      // Full-content feeds (e.g. WordPress) put the entire post body in
      // <content:encoded>; <description> is only the excerpt. Keep the raw HTML
      // so syncRSS can store the full body, falling back to the description
      // when the feed omits it.
      content: xmlHtml(x, 'content:encoded'),
      pubDate: xmlText(x, 'pubDate'),
      author: xmlText(x, 'dc:creator') || xmlText(x, 'author'),
      guid: xmlText(x, 'guid') || xmlText(x, 'link'),
      categories: [...x.matchAll(/<category[^>]*>([^<]+)<\/category>/g)].map((c) => c[1].trim()),
    });
  }

  // Fallback: Atom <entry>
  if (items.length === 0) {
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const x = m[1];
      // Atom uses <link href="..." rel="alternate"/> (self-closing, attribute
      // order varies). Prefer the explicit alternate link, then fall back to any
      // bare <link href="..."/> (many feeds omit rel entirely), then to the
      // element text of a <link>…</link>.
      const linkMatch =
        x.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/) ||
        x.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) ||
        x.match(/<link[^>]*href="([^"]+)"/);
      const link = linkMatch ? linkMatch[1] : xmlText(x, 'link');

      const rawSummary = xmlHtml(x, 'summary') || xmlHtml(x, 'content');
      const description = stripHtmlTags(decodeHtmlEntities(rawSummary))
        .replaceAll(/\s+/g, ' ')
        .trim();
      // Prefer the full <content> body (decoded HTML) over the <summary> excerpt,
      // so full-text Atom feeds keep their full post.
      const rawContent = xmlHtml(x, 'content') || xmlHtml(x, 'summary');

      items.push({
        title: xmlText(x, 'title'),
        link,
        description: description.slice(0, 1000),
        content: decodeHtmlEntities(rawContent),
        pubDate: xmlText(x, 'published') || xmlText(x, 'updated'),
        author: xmlText(x, 'name') || xmlText(x, 'author'),
        guid: xmlText(x, 'id') || link,
      });
    }
  }

  return items;
}
