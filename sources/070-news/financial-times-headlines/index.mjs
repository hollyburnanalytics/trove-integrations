/**
 * Financial Times Connector
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

import { feedItemDocument, syncFeeds } from '../../lib/feed-sync.mjs';

const BASE_URL = 'https://www.ft.com';
const DEFAULT_SECTIONS = ['world', 'technology', 'markets', 'climate-capital', 'companies'];

export async function sync(context) {
  const sections = context.config?.sections || DEFAULT_SECTIONS;
  return syncFeeds(context, {
    feeds: sections.map((section) => ({
      url: `${BASE_URL}/${section}?format=rss`,
      label: section,
    })),
    label: 'FT sections',
    toDocument: (item) => feedItemDocument('ft', item, { defaultAuthor: 'Financial Times' }),
  });
}
