import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.mjs';

export default defineSource({
  id: 'marginal-revolution',
  name: 'Marginal Revolution',
  description: 'Tyler Cowen and Alex Tabarrok on economics and ideas',
  icon: '📈',
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
  egress: ['marginalrevolution.com'],
  historyReach: {
    kind: 'window',
    note: 'An RSS feed carries only the posts the publisher chose to include, commonly the most recent 10 to 50. Anything older is not in the feed.',
  },
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://marginalrevolution.com/feed',
      idPrefix: 'mr',
      defaultAuthor: 'Tyler Cowen and Alex Tabarrok',
    });
  },
});
