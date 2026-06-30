import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncRSS(context, {
    feedUrl: 'https://theconversation.com/articles.atom',
    idPrefix: 'tc',
    defaultAuthor: 'The Conversation',
  });
}
