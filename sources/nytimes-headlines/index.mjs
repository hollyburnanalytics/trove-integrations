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

import { stringList } from '@ontrove/extend/source';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.mjs';

const FEED_BASE = 'https://rss.nytimes.com/services/xml/rss/nyt';
const DEFAULT_SECTIONS = ['HomePage'];

/**
 * Sync this source: fetch what is new and return it as documents.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @returns {Promise<import('../lib/types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function sync(context) {
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
}
