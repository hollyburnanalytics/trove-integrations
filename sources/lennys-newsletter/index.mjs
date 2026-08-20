import { defineSource } from '@ontrove/extend/source';
import { syncRSS } from '../lib/feeds.mjs';

export default defineSource({
  id: "lennys-newsletter",
  name: "Lenny's Newsletter",
  description: "Lenny Rachitsky on product, growth, and career",
  icon: "🎯",
  version: "0.1.0",
  author: "Hollyburn Analytics Inc.",
  kind: "scheduled-sync",
  transport: "feed",
  cursor: "date",
  ingest: "append",
  runsIn: "cloud",
  schedule: "weekly",
  status: "implemented",
  needsBrowser: false,
  egress: [
    "www.lennysnewsletter.com"
  ],
  historyReach: {
    "kind": "window",
    "note": "An RSS feed carries only the posts the publisher chose to include, commonly the most recent 10 to 50. Anything older is not in the feed."
  },
  async sync(context) {
    return syncRSS(context, {
      feedUrl: 'https://www.lennysnewsletter.com/feed',
      idPrefix: 'lenny',
      defaultAuthor: 'Lenny Rachitsky',
    });
},
});
