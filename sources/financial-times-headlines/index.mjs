/**
 * Financial Times source
 *
 * Fetches headlines and summaries from the FT's public RSS feeds.
 * No auth required — the RSS feeds provide headlines and summaries only.
 *
 * Supports multiple sections via config.sections.
 * Available sections: world, us, companies, technology, markets, climate-capital,
 * opinion, work-technology, moral-money, lex, alphaville, htsi,
 * companies/energy, companies/financials, companies/health, companies/industrials,
 * companies/media, companies/property, companies/retail-consumer,
 * companies/technology, companies/telecoms, companies/transport,
 * world/uk, world/us, world/asia-pacific, world/europe, world/africa,
 * world/americas, world/middle-east, markets/currencies, markets/commodities,
 * markets/equities, markets/fund-management, markets/trading, etc.
 */

import { stringList } from '@ontrove/extend/source';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.mjs';

const BASE_URL = 'https://www.ft.com';
const DEFAULT_SECTIONS = ['world', 'technology', 'markets', 'climate-capital', 'companies'];

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
    feeds: sections.map((section) => ({
      url: `${BASE_URL}/${section}?format=rss`,
      label: section,
    })),
    label: 'FT sections',
    toDocument: (item) => feedItemDocument('ft', item, { defaultAuthor: 'Financial Times' }),
  });
}
