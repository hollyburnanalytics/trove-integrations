import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://avc.com/feed',
    idPrefix: 'avc',
    defaultAuthor: 'Fred Wilson',
  });
}
