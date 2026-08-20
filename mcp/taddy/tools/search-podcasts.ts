import { tool, z } from '@ontrove/extend/toolkit';
import { commonSearchFields, dateField } from '../params.ts';
import { renderFilters, renderList, renderPodcastLine } from '../render.ts';
import { podcastSearchOutput, searchPodcasts } from '../search.ts';

/**
 * `search_podcasts` — keyword search over podcast SHOWS.
 */
export const searchPodcastsTool = tool({
  name: 'search_podcasts',
  title: 'Taddy: Search podcasts',
  description:
    'Find podcast SHOWS by keyword across Taddy’s directory of 4M+ podcasts. Filter by genre, ' +
    'language, country, audio/video, publication date and episode count. Returns each show’s ' +
    'uuid — pass it to get_podcast for episodes, or get_latest_episodes to follow it. To find ' +
    'individual episodes rather than shows, use search_episodes.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    term: z.string().min(1).describe('Search keywords, e.g. "history of Rome".'),
    ...commonSearchFields,
    updated_after: dateField('Only shows with an episode published on/after this date.'),
    min_episodes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Only shows with more than this many episodes.'),
    max_episodes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Only shows with fewer than this many episodes.'),
  }),
  output: podcastSearchOutput,
  async handler(args, ctx) {
    ctx.log('search_podcasts', { term: args.term, page: args.page });
    const result = await searchPodcasts(ctx, args);
    const filters = renderFilters(result.filters);
    const heading =
      result.count === 0
        ? `No podcasts on Taddy matching "${args.term}".`
        : `${String(result.count)}${result.totalCount === null ? '' : ` of ${String(result.totalCount)}`} podcast(s) for "${args.term}" (page ${String(result.page)}):`;
    return {
      text: renderList(
        filters ? `${filters}\n${heading}` : heading,
        result.podcasts.map((p) => renderPodcastLine(p)),
      ),
      structured: result,
    };
  },
});
