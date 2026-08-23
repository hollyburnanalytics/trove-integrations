import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.ts';

export default defineSource({
  id: 'bits-about-money',
  name: 'Bits about Money',
  description: 'Patrick McKenzie (patio11) on how money and banking actually work',
  icon: '🏦',
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
  egress: ['www.bitsaboutmoney.com'],
  historyReach: {
    kind: 'window',
    note: 'An RSS feed carries only the posts the publisher chose to include, commonly the most recent 10 to 50. Anything older is not in the feed.',
  },
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://www.bitsaboutmoney.com/archive/rss/',
      idPrefix: 'bam',
      defaultAuthor: 'Patrick McKenzie',
    });
  },
});
