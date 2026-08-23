import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.ts';

export default defineSource({
  id: 'the-conversation',
  name: 'The Conversation',
  description: 'Explainers and analysis written by academics across every field (CC-BY-ND)',
  icon: '🎓',
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
  egress: ['theconversation.com'],
  historyReach: {
    kind: 'recent-only',
    note: 'A news feed carries only what is on the front page now — typically the last day or two. Older stories are not in the feed and cannot be fetched.',
  },
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://theconversation.com/articles.atom',
      idPrefix: 'tc',
      defaultAuthor: 'The Conversation',
    });
  },
});
