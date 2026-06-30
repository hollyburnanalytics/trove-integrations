/**
 * Shared utilities for feed connectors: HTTP fetch, RSS/Atom parsing, and a
 * complete `syncRSS()` sync. Feed bodies are stored as plain text (decoded,
 * tags stripped) — we deliberately do not try to reconstruct rich Markdown.
 */

import { createHash } from 'node:crypto';
import { parse } from 'node-html-parser';
import { dateWatermark, readDateWatermark } from './watermark.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip HTML tags from a string by matching angle-bracketed sequences.
 * Uses a simple state-machine approach to avoid regex backtracking issues.
 */
function stripHtmlTags(input) {
  let result = '';
  let inTag = false;
  for (const char of input) {
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
    } else if (!inTag) {
      result += char;
    }
  }
  return result;
}

const HEADERS = {
  // Descriptive, attributable User-Agent that identifies this client honestly.
  'User-Agent': 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

// Per-request ceiling. Without it a single slow/hung host stalls an entire sync
// run for minutes (until the host process is killed). A bounded request fails
// fast and is retried next run.
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Whether the host-provided soft deadline has passed. The host sets
 * `context.deadline` to an absolute epoch-ms timestamp a safe margin before it
 * hard-kills the run; paged connectors check it so a large first run splits
 * across runs (fetch what fits, advance the cursor, resume next run). An absent
 * deadline means "unbounded".
 */
export function deadlineReached(context) {
  return typeof context.deadline === 'number' && Date.now() >= context.deadline;
}

/**
 * Generate a stable, collision-resistant ID from a string.
 */
export function stableId(prefix, input) {
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

/**
 * Safely parse a date string. Returns a valid ISO string or undefined.
 */
export function safeDate(dateString) {
  if (!dateString) return;
  const d = new Date(dateString);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Decode common HTML entities (including numeric).
 */
export function decodeHtmlEntities(string_) {
  return string_
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&'); // amp last so we don't double-decode
}

/**
 * Reduce an HTML (or already-plain) fragment to clean plain text: decode
 * entities, drop tags, and tidy whitespace while keeping line breaks. We store
 * feed bodies as raw text rather than (lossily) converting markup to Markdown.
 */
export function htmlToText(html) {
  if (!html) return '';
  // Decode → strip → decode: feed bodies are HTML that was itself entity-encoded
  // for XML embedding, so unwrapping one level exposes a second (e.g. `&amp;amp;`
  // → `&amp;` → `&`).
  return decodeHtmlEntities(stripHtmlTags(decodeHtmlEntities(html)))
    .split('\n')
    .map((line) => line.replaceAll(/[^\S\n]+/g, ' ').trim()) // tidy each line
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n') // cap consecutive blank lines
    .trim();
}

/**
 * Extract a tag's text content from an XML fragment.
 * Handles CDATA and plain text. Tag names are treated as literals, not regex.
 */
export function xmlText(xml, tag) {
  const t = tag.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const m =
    xml.match(new RegExp(String.raw`<${t}><!\[CDATA\[([\s\S]*?)\]\]><\/${t}>`)) ||
    xml.match(new RegExp(String.raw`<${t}>([^<]*)<\/${t}>`));
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

/** IPv4/IPv6 hosts in private, loopback, or link-local ranges (SSRF guard). */
function isPrivateHost(host) {
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = numbers;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) || // link-local, incl. the 169.254.169.254 metadata IP
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) // CGNAT
  );
}

/**
 * Guard a URL before fetching. Feed `<link>` targets come from the publisher,
 * not us, so a hostile or compromised feed could aim them at localhost, a cloud
 * metadata endpoint, or an internal IP. We only ever want public web pages, so
 * require http(s) and reject private/loopback/link-local hosts.
 */
function assertPublicHttpUrl(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`Invalid URL: ${target}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing non-HTTP(S) URL: ${target}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateHost(host)
  ) {
    throw new Error(`Refusing to fetch private or loopback host: ${host}`);
  }
}

/**
 * Fetch a URL with our honest bot UA, a hard timeout, and a response-size cap.
 * Rejects non-public hosts (SSRF guard), throws on non-200. Returns body text.
 */
export async function fetchPage(url) {
  assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large (${contentLength} bytes) for ${url}`);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        reader.cancel();
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Fetch and parse an RSS/Atom feed, returning TroveDocuments.
 * Supports incremental sync via a `date` watermark — only returns items
 * published after the cursor date. Cursor advances to max date of returned items.
 */
export async function syncRSS(context, { feedUrl, idPrefix, defaultAuthor }) {
  context.log.info(`Fetching ${feedUrl}...`);
  const xml = await fetchPage(feedUrl);
  const items = parseRSS(xml);

  const lastDate = readDateWatermark(context.cursor);
  const filtered = lastDate
    ? items.filter((item) => {
        if (!item.pubDate) return true; // include items with no date (conservative)
        const d = new Date(item.pubDate);
        return Number.isNaN(d.getTime()) || d > lastDate;
      })
    : items;

  const skipped = items.length - filtered.length;
  const skippedSuffix = skipped > 0 ? ` (${skipped} already seen)` : '';
  context.log.info(`Found ${items.length} items${skippedSuffix}`);
  context.progress(0, `Processing ${filtered.length} items...`);

  const documents = filtered.map((item) => ({
    id: stableId(idPrefix, item.guid || item.link || item.title),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    // Store the full body (<content:encoded> / Atom <content>) as plain text,
    // falling back to the excerpt for headline-only feeds.
    text: [
      decodeHtmlEntities(item.title || ''),
      htmlToText((item.content || '').trim() || item.description || ''),
    ]
      .filter(Boolean)
      .join('\n\n'),
    url: item.link,
    author: item.author || defaultAuthor,
    date: safeDate(item.pubDate) || new Date().toISOString(),
  }));

  // Cursor = max pubDate of RETURNED items (not all items — avoids jumping past unsynced items)
  const returnedDates = filtered
    .map((index) => (index.pubDate ? new Date(index.pubDate).getTime() : 0))
    .filter((d) => d > 0);
  const maxDate =
    returnedDates.length > 0 ? new Date(Math.max(...returnedDates)).toISOString() : undefined;
  const cursor = maxDate ? dateWatermark(maxDate) : context.cursor || undefined;

  return { documents, cursor, stats: { fetched: documents.length, skipped } };
}

/**
 * Fetch one article page and extract its body as plain text. `articleSelector`
 * targets the prose container(s) for the site (e.g. `'article'`), so we keep the
 * article and drop nav/share/footer chrome. Falls back to `<article>`/`<main>`
 * when the selector matches nothing.
 *
 * Only use this for sources whose license permits storing the full text
 * (Creative Commons / public domain) — for all-rights-reserved feeds, store the
 * publisher's syndicated excerpt via `syncRSS()` instead.
 */
export async function fetchArticleText(url, articleSelector) {
  const root = parse(await fetchPage(url));
  for (const element of root.querySelectorAll('script, style, noscript')) element.remove();
  const matched = articleSelector ? root.querySelectorAll(articleSelector) : [];
  const containers =
    matched.length > 0
      ? matched
      : [root.querySelector('article') || root.querySelector('main') || root];
  const html = containers
    .map((node) => node.innerHTML)
    .join('\n\n')
    // keep paragraph breaks before tags are stripped
    .replaceAll(/<\/(?:p|h[1-6]|li|blockquote)>/gi, '$&\n\n');
  return htmlToText(html);
}

/**
 * Like `syncRSS()`, but the feed only carries excerpts, so for each new item we
 * fetch the article page and store its full text (via {@link fetchArticleText}).
 * Items are processed oldest-first and the run stops at the host's soft deadline,
 * so a large first run resumes cleanly from the `date` watermark. A per-article
 * fetch failure falls back to the feed's excerpt rather than dropping the item.
 *
 * CC / public-domain sources only — see {@link fetchArticleText}.
 */
async function articleToDocument(context, item, { idPrefix, defaultAuthor, articleSelector }) {
  let body;
  try {
    body = await fetchArticleText(item.link, articleSelector);
  } catch (error) {
    context.log.warn(`Failed to fetch ${item.link}: ${error.message}`);
    body = item.description || ''; // fall back to the feed excerpt
  }
  return {
    id: stableId(idPrefix, item.guid || item.link),
    title: decodeHtmlEntities(item.title || 'Untitled'),
    text: [decodeHtmlEntities(item.title || ''), body].filter(Boolean).join('\n\n'),
    url: item.link,
    author: item.author || defaultAuthor,
    date: safeDate(item.pubDate) || new Date().toISOString(),
  };
}

export async function syncFeedArticles(
  context,
  { feedUrl, idPrefix, defaultAuthor, articleSelector, delayMs = 300 },
) {
  context.log.info(`Fetching ${feedUrl}...`);
  const items = parseRSS(await fetchPage(feedUrl));
  const lastDate = readDateWatermark(context.cursor);

  const fresh = items
    .filter((item) => {
      if (!lastDate || !item.pubDate) return true;
      const d = new Date(item.pubDate);
      return Number.isNaN(d.getTime()) || d > lastDate;
    })
    .toSorted((a, b) => new Date(a.pubDate || 0).getTime() - new Date(b.pubDate || 0).getTime());

  const documents = [];
  const dates = [];
  let stoppedEarly = false;
  for (const [index, item] of fresh.entries()) {
    if (deadlineReached(context)) {
      context.log.info('Time budget reached — resuming next run');
      stoppedEarly = true;
      break;
    }
    documents.push(
      await articleToDocument(context, item, { idPrefix, defaultAuthor, articleSelector }),
    );
    const t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
    if (t > 0) dates.push(t);
    context.progress(documents.length, `${documents.length} articles`);
    if (delayMs && index < fresh.length - 1) await sleep(delayMs);
  }

  const maxIso = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : undefined;
  const cursor = maxIso ? dateWatermark(maxIso) : context.cursor || undefined;
  return {
    documents,
    cursor,
    stats: {
      fetched: documents.length,
      remaining: stoppedEarly ? fresh.length - documents.length : 0,
    },
  };
}
