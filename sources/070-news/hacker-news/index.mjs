import { htmlToText } from '../../lib/feeds.mjs';

export async function sync(context) {
  context.log.info('Fetching Hacker News front page stories...');

  const response = await fetch(
    'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15',
  );

  if (!response.ok) {
    throw new Error(`HN API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  context.progress(0, `Processing ${data.hits.length} stories...`);

  const documents = data.hits.map((hit) => ({
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
    date: hit.created_at,
  }));

  context.log.info(`Fetched ${documents.length} stories`);

  return {
    documents,
    cursor: undefined,
    stats: { fetched: documents.length },
  };
}
