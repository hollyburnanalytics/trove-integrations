import { defineSource } from '@ontrove/extend/source';
import { htmlToText, safeDate, undatedStats, warnIfUndated } from '../lib/feeds.ts';

/**
 * One Algolia search hit, as the front-page query returns it.
 */
type Hit = {
  objectID: string;
  title?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  story_text?: string;
  author?: string;
  created_at?: string;
};

export default defineSource({
  id: 'hacker-news',
  name: 'Hacker News',
  description: 'Top stories from the HN front page',
  icon: '🔶',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'none',
  ingest: 'append',
  runsIn: 'mac',
  schedule: 'every 1 hour',
  status: 'implemented',
  needsBrowser: false,
  egress: ['hn.algolia.com'],
  egressNote:
    "The Algolia HN search API only; news.ycombinator.com appears as a story's stored URL when the submission links nowhere else, and is never fetched.",
  egressNotFetched: ['news.ycombinator.com'],
  async sync(context) {
    context.log.info('Fetching Hacker News front page stories...');

    const response = await fetch(
      'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15',
    );

    if (!response.ok) {
      throw new Error(`HN API returned ${response.status}: ${response.statusText}`);
    }
    const data: { hits: Hit[] } = await response.json();

    context.progress(0, `Processing ${data.hits.length} stories...`);
    const documents: import('../lib/types.js').Document[] = data.hits.map((hit) => ({
      id: `hn-${hit.objectID}`,
      title: hit.title || 'Untitled',
      text: [
        hit.title,
        hit.url ? `URL: ${hit.url}` : undefined,
        `Points: ${hit.points || 0} | Comments: ${hit.num_comments || 0}`,
        // Algolia returns Ask-HN bodies as entity-encoded HTML — store as plain text.
        hit.story_text ? htmlToText(hit.story_text) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      author: hit.author,
      // The story's submission time — the closest thing HN has to a publish
      // date (the linked article's own date is not in the Algolia payload).
      date: safeDate(hit.created_at),
    }));

    context.log.info(`Fetched ${documents.length} stories`);
    warnIfUndated(context, documents, 'Hacker News front page');

    return {
      documents,
      cursor: undefined,
      stats: { fetched: documents.length, ...undatedStats(documents) },
    };
  },
});
