import { feedItemDocument, syncFeeds } from '../../lib/feed-sync.mjs';

export async function sync(context) {
  const feeds = (context.config.feeds || []).map((url) => ({ url }));
  return syncFeeds(context, {
    feeds,
    label: 'RSS feeds',
    emptyWarning: 'No feeds configured',
    // Subscribed blogs get the fullest body the feed provides — not the
    // excerpt — plus the feed's own categories as tags.
    toDocument: (item) => feedItemDocument('rss', item, { fullText: true, tags: item.categories }),
  });
}
