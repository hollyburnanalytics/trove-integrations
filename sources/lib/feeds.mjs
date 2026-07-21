/**
 * The shared-helper entry point for feed source adapters. The complete
 * `syncRSS()` / `syncFeedArticles()` syncs and the single-article fetch live
 * here; the lower-level primitives they build on are re-exported from their
 * focused modules (`http.mjs`, `rss-parse.mjs`, `text.mjs`) so adapters keep
 * importing everything from one place. Feed bodies are stored as plain text
 * (decoded, tags stripped) — we deliberately do not try to reconstruct rich
 * Markdown.
 */

import { parse } from 'node-html-parser';
import { fetchPage } from './http.mjs';
import { parseRSS } from './rss-parse.mjs';
import { decodeHtmlEntities, htmlToText, safeDate, stableId } from './text.mjs';
import { dateWatermark, readDateWatermark } from './watermark.mjs';

// Re-export the feed primitives so `feeds.mjs` stays the single import surface
// for adapters, even though the implementations live in focused sibling modules.
export { fetchPage } from './http.mjs';
export { parseRSS, xmlText } from './rss-parse.mjs';
export { decodeHtmlEntities, htmlToText, safeDate, stableId } from './text.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the host-provided soft deadline has passed. The host sets
 * `context.deadline` to an absolute epoch-ms timestamp a safe margin before it
 * hard-kills the run; paged source adapters check it so a large first run splits
 * across runs (fetch what fits, advance the cursor, resume next run). An absent
 * deadline means "unbounded".
 */
export function deadlineReached(context) {
  return typeof context.deadline === 'number' && Date.now() >= context.deadline;
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
    // Store the fullest body the feed provides (content:encoded / Atom
    // <content>, falling back to the raw description markup) as plain text.
    text: [
      decodeHtmlEntities(item.title || ''),
      htmlToText(item.bodyHtml || item.description || ''),
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
