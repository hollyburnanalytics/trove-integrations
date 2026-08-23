import { defineSource } from '@ontrove/extend/source';
import { syncFeedArticles } from '../lib/feeds.mjs';

export default defineSource({
  id: 'our-world-in-data',
  name: 'Our World in Data',
  description:
    'Research and data on how the world is changing, across health, poverty, energy and more (CC-BY)',
  icon: '🌍',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'scrape',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'mac',
  schedule: 'daily',
  status: 'implemented',
  needsBrowser: false,
  egress: ['ourworldindata.org'],
  historyReach: {
    kind: 'window',
    note: 'This source reads an index page, so it reaches back as far as that page lists and no further.',
  },
  egressNote:
    'The Atom feed and every article page it links are on ourworldindata.org — this source fetches the page, not just the feed entry.',
  async sync(context) {
    return syncFeedArticles(context, {
      feedUrl: 'https://ourworldindata.org/atom.xml',
      idPrefix: 'owid',
      defaultAuthor: 'Our World in Data',
      articleSelector: 'article.centered-article-container',
    });
  },
});
