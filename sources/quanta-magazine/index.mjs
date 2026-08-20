import { defineSource } from '@ontrove/extend/source';
import { syncFeedArticles } from '../lib/feeds.mjs';

export default defineSource({
  id: "quanta-magazine",
  name: "Quanta Magazine",
  description: "In-depth journalism on math, physics, biology and computer science (CC-BY-NC-ND)",
  icon: "🔬",
  version: "0.1.0",
  author: "Hollyburn Analytics Inc.",
  kind: "scheduled-sync",
  transport: "scrape",
  cursor: "date",
  ingest: "append",
  runsIn: "mac",
  schedule: "daily",
  status: "implemented",
  needsBrowser: false,
  egress: [
    "www.quantamagazine.org"
  ],
  historyReach: {
    "kind": "window",
    "note": "This source reads an index page, so it reaches back as far as that page lists and no further."
  },
  egressNote: "The feed and every article page it links are on www.quantamagazine.org — this source fetches the page, not just the feed entry.",
  async sync(context) {
    return syncFeedArticles(context, {
      feedUrl: 'https://www.quantamagazine.org/feed/',
      idPrefix: 'quanta',
      defaultAuthor: 'Quanta Magazine',
      articleSelector: '.post__content__section.wysiwyg',
    });
},
});
