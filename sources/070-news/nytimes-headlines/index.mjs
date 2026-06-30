/**
 * New York Times Connector
 *
 * Fetches headlines and summaries from NYT public RSS feeds.
 * No auth required — the RSS feeds provide headlines and summaries only.
 *
 * Supports multiple sections via config.sections (default: HomePage).
 * Available sections: HomePage, World, US, Politics, Business, Technology,
 * Science, Health, Sports, Arts, Books, etc.
 */

import { feedItemDocument, syncFeeds } from '../../lib/feed-sync.mjs';

const FEED_BASE = 'https://rss.nytimes.com/services/xml/rss/nyt';
const DEFAULT_SECTIONS = ['HomePage'];

export async function sync(context) {
  const sections = context.config?.sections || DEFAULT_SECTIONS;
  return syncFeeds(context, {
    feeds: sections.map((section) => ({ url: `${FEED_BASE}/${section}.xml`, label: section })),
    label: 'NYTimes sections',
    toDocument: (item) => feedItemDocument('nyt', item, { defaultAuthor: 'The New York Times' }),
  });
}
