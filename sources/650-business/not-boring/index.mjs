import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://www.notboring.co/feed',
    idPrefix: 'notboring',
    defaultAuthor: 'Packy McCormick',
  });
}
