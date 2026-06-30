import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://stratechery.com/feed/',
    idPrefix: 'strat',
    defaultAuthor: 'Ben Thompson',
  });
}
