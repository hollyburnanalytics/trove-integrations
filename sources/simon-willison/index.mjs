import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.mjs';

export default defineSource({
  id: 'simon-willison',
  name: 'Simon Willison',
  description: 'All posts from simonwillison.net (2002-present)',
  icon: '✍️',
  version: '0.1.1',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'feed',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'daily',
  status: 'implemented',
  needsBrowser: false,
  egress: ['simonwillison.net'],
  historyReach: {
    kind: 'window',
    note: 'An RSS feed carries only the posts the publisher chose to include, commonly the most recent 10 to 50. Anything older is not in the feed.',
  },
  formatting: 'verbatim',
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://simonwillison.net/atom/everything/',
      idPrefix: 'sw',
      defaultAuthor: 'Simon Willison',
    });
  },
});
