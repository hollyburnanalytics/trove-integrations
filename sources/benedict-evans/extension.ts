import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.ts';

export default defineSource({
  id: 'benedict-evans',
  name: 'Benedict Evans',
  description: 'Weekly analysis of technology trends and shifts',
  icon: '📱',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'feed',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'daily',
  status: 'implemented',
  needsBrowser: false,
  egress: ['www.ben-evans.com'],
  historyReach: {
    kind: 'window',
    note: 'An RSS feed carries only the posts the publisher chose to include, commonly the most recent 10 to 50. Anything older is not in the feed.',
  },
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://www.ben-evans.com/benedictevans?format=rss',
      idPrefix: 'bevans',
      defaultAuthor: 'Benedict Evans',
    });
  },
});
