import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://www.lennysnewsletter.com/feed',
    idPrefix: 'lenny',
    defaultAuthor: 'Lenny Rachitsky',
  });
}
