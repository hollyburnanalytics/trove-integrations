import { defineSource, stringList } from '@ontrove/extend/source';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.ts';

export default defineSource({
  id: 'rss-feeds',
  name: 'RSS Feeds',
  description:
    'Subscribe to any blog or news feed — RSS, Atom, or JSON Feed. Paste feed URLs (or just the site URL) and Trove stores the full text of every post.',
  icon: '📡',
  version: '0.2.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'feed',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'every 2 hours',
  status: 'implemented',
  needsBrowser: false,
  egress: ['config:feeds'],
  historyReach: {
    kind: 'window',
    note: "How far back an RSS feed goes is the publisher's choice — some carry years, many carry only the last few dozen posts.",
  },
  egressNote:
    'Fetches the feed or site URLs the user configures, so the reachable hosts are theirs and cannot be listed here; a pasted site URL is followed once more to the feed that page advertises.',
  config: {
    feeds: {
      label: 'Feed URLs',
      type: 'url[]',
      directory: {
        provider: 'feeds',
        mode: 'resolve',
        placeholder: 'Paste a site or feed URL',
      },
    },
  },
  fanOut: 'feeds',
  available: true,
  formatting: 'reformat',
  async sync(context) {
    const feeds = stringList(context.config.feeds).map((url) => ({ url }));
    return syncFeeds(context, {
      feeds,
      label: 'RSS feeds',
      emptyWarning: 'No feeds configured',
      // Subscribed blogs get the fullest body the feed provides — not the
      // excerpt — plus the feed's own categories as tags.
      toDocument: (item) =>
        feedItemDocument('rss', item, { fullText: true, tags: item.categories }),
    });
  },
});
