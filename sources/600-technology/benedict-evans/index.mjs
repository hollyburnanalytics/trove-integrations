import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://www.ben-evans.com/benedictevans?format=rss',
    idPrefix: 'bevans',
    defaultAuthor: 'Benedict Evans',
  });
}
