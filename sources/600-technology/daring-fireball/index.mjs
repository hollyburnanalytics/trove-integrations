import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://daringfireball.net/feeds/main',
    idPrefix: 'df',
    defaultAuthor: 'John Gruber',
  });
}
