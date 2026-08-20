/**
 * New York Times source
 *
 * Fetches headlines and summaries from NYT public RSS feeds.
 * No auth required — the RSS feeds provide headlines and summaries only.
 *
 * Supports multiple sections via config.sections (default: HomePage).
 * Available sections: HomePage, World, US, Politics, Business, Technology,
 * Science, Health, Sports, Arts, Books, etc.
 */

import { defineSource, stringList } from '@ontrove/extend/source';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.mjs';

const FEED_BASE = 'https://rss.nytimes.com/services/xml/rss/nyt';
const DEFAULT_SECTIONS = ['HomePage'];

export default defineSource({
  id: "nytimes-headlines",
  name: "NYTimes Headlines",
  description: "Top headlines from the New York Times homepage via RSS (no full article text)",
  icon: "📰",
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
    "rss.nytimes.com"
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
        "HomePage"
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
      feeds: sections.map((section) => ({ url: `${FEED_BASE}/${section}.xml`, label: section })),
      label: 'NYTimes sections',
      toDocument: (item) => feedItemDocument('nyt', item, { defaultAuthor: 'The New York Times' }),
    });
},
});
