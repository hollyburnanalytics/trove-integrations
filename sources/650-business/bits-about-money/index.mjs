import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://www.bitsaboutmoney.com/archive/rss/',
    idPrefix: 'bam',
    defaultAuthor: 'Patrick McKenzie',
  });
}
