import { syncFeedArticles } from '../../lib/feeds.mjs';

export async function sync(context) {
  return syncFeedArticles(context, {
    feedUrl: 'https://ourworldindata.org/atom.xml',
    idPrefix: 'owid',
    defaultAuthor: 'Our World in Data',
    articleSelector: 'article.centered-article-container',
  });
}
