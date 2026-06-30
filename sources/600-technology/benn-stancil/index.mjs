import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://benn.substack.com/feed',
    idPrefix: 'benn',
    defaultAuthor: 'Benn Stancil',
  });
}
