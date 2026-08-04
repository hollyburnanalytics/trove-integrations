/**
 * The Guardian source
 *
 * Fetches headlines and summaries from The Guardian's public RSS feeds.
 * No auth required — RSS feeds are open.
 *
 * Supports multiple sections via config.sections (default: uk, world, technology, business).
 * Available sections: uk, world, technology, business, science, environment,
 * politics, commentisfree, sport, football, culture, film, music, books, etc.
 */

import { feedItemDocument, syncFeeds } from '../../lib/feed-sync.mjs';

const BASE_URL = 'https://www.theguardian.com';
const DEFAULT_SECTIONS = ['uk', 'world', 'technology', 'business'];

/** The trailer the feed appends to every summary. */
const BOILERPLATE = 'Continue reading...';

function toDocument(item) {
  const document = feedItemDocument('guardian', item, {
    defaultAuthor: 'The Guardian',
    tags: item.categories,
  });
  // The feed appends a boilerplate "Continue reading" link to every summary —
  // all 45 items in a live pull carry it. Two forms, because the body reaches
  // here as the feed's PLAIN-TEXT summary (`item.description`, already
  // tag-stripped) where the anchor is just its label; the markdown form only
  // survives on the full-text path. Stripping only the markdown form left the
  // boilerplate on every Guardian document.
  const withoutLink = document.text
    .replaceAll(/\[Continue reading\.\.\.\]\([^)]*\)/gi, '')
    .trimEnd();
  // Suffix check rather than a `\s*…\s*$` regex, which backtracks (ReDoS).
  document.text = withoutLink.toLowerCase().endsWith(BOILERPLATE.toLowerCase())
    ? withoutLink.slice(0, -BOILERPLATE.length).trim()
    : withoutLink.trim();
  return document;
}

export async function sync(context) {
  const sections = context.config?.sections || DEFAULT_SECTIONS;
  return syncFeeds(context, {
    feeds: sections.map((section) => ({ url: `${BASE_URL}/${section}/rss`, label: section })),
    label: 'Guardian sections',
    toDocument,
  });
}
