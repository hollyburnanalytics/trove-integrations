/**
 * BBC News source
 *
 * Fetches headlines and summaries from BBC News public RSS feeds.
 * No auth required — RSS feeds are open.
 *
 * Supports multiple sections via config.sections
 * (default: top_stories, world, uk, technology, business).
 * Available sections: top_stories, world, uk, business, technology,
 * science_and_environment, health, education, entertainment_and_arts, politics.
 */

import { feedItemDocument, syncFeeds } from '../../lib/feed-sync.mjs';

const FEED_BASE = 'https://feeds.bbci.co.uk/news';
const DEFAULT_SECTIONS = ['top_stories', 'world', 'uk', 'technology', 'business'];

function feedUrl(section) {
  if (section === 'top_stories') return `${FEED_BASE}/rss.xml`;
  return `${FEED_BASE}/${section}/rss.xml`;
}

export async function sync(context) {
  const sections = context.config?.sections || DEFAULT_SECTIONS;
  return syncFeeds(context, {
    feeds: sections.map((section) => ({ url: feedUrl(section), label: section, section })),
    label: 'BBC News sections',
    toDocument: (item, feed) =>
      feedItemDocument('bbc', item, { defaultAuthor: 'BBC News', tags: [feed.section] }),
  });
}
