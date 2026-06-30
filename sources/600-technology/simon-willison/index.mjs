import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://simonwillison.net/atom/entries/',
    idPrefix: 'sw',
    defaultAuthor: 'Simon Willison',
  });
}
