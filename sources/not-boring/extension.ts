import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.ts';

export default defineSource({
  id: 'not-boring',
  name: 'Not Boring',
  description: "Packy McCormick on companies, strategy, and what's getting funded",
  icon: '🚀',
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
  egress: ['www.notboring.co'],
  historyReach: {
    kind: 'window',
    note: 'An RSS feed carries only the posts the publisher chose to include, commonly the most recent 10 to 50. Anything older is not in the feed.',
  },
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://www.notboring.co/feed',
      idPrefix: 'notboring',
      defaultAuthor: 'Packy McCormick',
    });
  },
});
