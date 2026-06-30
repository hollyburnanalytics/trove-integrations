import { feedItemDocument, syncFeeds } from '../../lib/feed-sync.mjs';

export async function sync(context) {
  const feeds = (context.config.feeds || []).map((url) => ({ url }));
  return syncFeeds(context, {
    feeds,
    label: 'RSS feeds',
    emptyWarning: 'No feeds configured',
    toDocument: (item) => feedItemDocument('rss', item),
  });
}
