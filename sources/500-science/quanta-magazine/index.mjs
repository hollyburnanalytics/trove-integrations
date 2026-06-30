import { syncFeedArticles } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncFeedArticles(context, {
    feedUrl: 'https://www.quantamagazine.org/feed/',
    idPrefix: 'quanta',
    defaultAuthor: 'Quanta Magazine',
    articleSelector: '.post__content__section.wysiwyg',
  });
}
