import { stringList } from '@ontrove/sdk';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.mjs';

/**
 * Sync this source: fetch what is new and return it as documents.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @returns {Promise<import('../lib/types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function sync(context) {
  const feeds = stringList(context.config.feeds).map((url) => ({ url }));
  return syncFeeds(context, {
    feeds,
    label: 'RSS feeds',
    emptyWarning: 'No feeds configured',
    // Subscribed blogs get the fullest body the feed provides — not the
    // excerpt — plus the feed's own categories as tags.
    toDocument: (item) => feedItemDocument('rss', item, { fullText: true, tags: item.categories }),
  });
}
