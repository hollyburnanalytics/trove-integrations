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

function toDocument(item) {
  const document = feedItemDocument('guardian', item, {
    defaultAuthor: 'The Guardian',
    tags: item.categories,
  });
  // The feed appends a boilerplate "Continue reading" link to every summary.
  document.text = document.text.replaceAll(/\[Continue reading\.\.\.\]\([^)]*\)/gi, '').trim();
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
