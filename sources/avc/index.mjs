import { syncRSS } from '../lib/feeds.mjs';

/**
 * Sync this source: fetch what is new and return it as documents.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @returns {Promise<import('../lib/types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://avc.com/feed',
    idPrefix: 'avc',
    defaultAuthor: 'Fred Wilson',
  });
}
