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

import { defineSource, stringList } from '@ontrove/extend/source';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.mjs';

const FEED_BASE = 'https://feeds.bbci.co.uk/news';
const DEFAULT_SECTIONS = ['top_stories', 'world', 'uk', 'technology', 'business'];

/**
 * The BBC feed for one section. `top_stories` is the unprefixed root feed.
 *
 * @param {string} section - The configured section name.
 * @returns {string} Its RSS URL.
 */
function feedUrl(section) {
  if (section === 'top_stories') return `${FEED_BASE}/rss.xml`;
  return `${FEED_BASE}/${section}/rss.xml`;
}

export default defineSource({
  id: "bbc-news-headlines",
  name: "BBC News Headlines",
  description: "Headlines and summaries from BBC News via RSS (no full article text)",
  icon: "📻",
  version: "0.1.0",
  author: "Hollyburn Analytics Inc.",
  kind: "scheduled-sync",
  transport: "feed",
  cursor: "date",
  ingest: "append",
  runsIn: "cloud",
  schedule: "every 2 hours",
  status: "implemented",
  needsBrowser: false,
  egress: [
    "feeds.bbci.co.uk"
  ],
  historyReach: {
    "kind": "recent-only",
    "note": "A news feed carries only what is on the front page now — typically the last day or two. Older stories are not in the feed and cannot be fetched."
  },
  config: {
    "sections": {
      "label": "Sections to fetch",
      "type": "array",
      "default": [
        "top_stories",
        "world",
        "uk",
        "technology",
        "business"
      ]
    }
  },
  async sync(context) {
    // `sections` is a `text[]` field, and a `text[]` field is user input: one
    // section typed into a list arrives as a bare string, on which `.map` throws
    // and takes the whole round with it. `stringList` is the narrowing every
    // fan-out source owes its config.
    const configured = stringList(context.config?.sections);
    const sections = configured.length > 0 ? configured : DEFAULT_SECTIONS;
    return syncFeeds(context, {
      feeds: sections.map((section) => ({ url: feedUrl(section), label: section })),
      label: 'BBC News sections',
      // The section tag reads off `label`, which every feed above sets to the
      // same string. The second copy this used to carry — a `section` field
      // stowed on the feed — was a property `Feed` does not declare, so nothing
      // upstream could see it and a renamed label would have silently detached
      // the tag from the feed it names.
      toDocument: (item, feed) =>
        feedItemDocument('bbc', item, {
          defaultAuthor: 'BBC News',
          tags: feed.label ? [feed.label] : [],
        }),
    });
},
});
