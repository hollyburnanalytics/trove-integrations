import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://marginalrevolution.com/feed',
    idPrefix: 'mr',
    defaultAuthor: 'Tyler Cowen and Alex Tabarrok',
  });
}
