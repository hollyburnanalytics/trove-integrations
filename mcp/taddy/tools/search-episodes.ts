import { tool, z } from '@ontrove/extend/toolkit';
import { uuidField } from '../fields.ts';
import { commonSearchFields } from '../params.ts';
import { renderEpisodeLine, renderFilters, renderList } from '../render.ts';
import { episodeSearchOutput, searchEpisodes } from '../search.ts';

/**
 * `search_episodes` — keyword search over individual EPISODES.
 */
export const searchEpisodesTool = tool({
  name: 'search_episodes',
  title: 'Taddy: Search episodes',
  description:
    'Find individual EPISODES by keyword across 200M+ episodes — searching titles and ' +
    'descriptions. Filter by duration, whether a transcript already exists, genre, language, ' +
    'country and publication date, and restrict to (or exclude) particular shows. Returns each ' +
    'episode’s uuid — pass it to get_transcript to read it.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    term: z.string().min(1).describe('Search keywords, e.g. "interview with Rick Rubin".'),
    ...commonSearchFields,
    min_duration_seconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Only episodes longer than this many seconds (1800 = 30 minutes).'),
    max_duration_seconds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Only episodes shorter than this many seconds.'),
    has_transcript: z
      .boolean()
      .optional()
      .describe(
        'True to return only episodes whose transcript is already available — the reliable way ' +
          'to find readable episodes without spending transcription credits.',
      ),
    podcast_uuids: z
      .array(uuidField('Podcast uuid.'))
      .max(25)
      .optional()
      .describe('Search only within these shows.'),
    exclude_podcast_uuids: z
      .array(uuidField('Podcast uuid.'))
      .max(25)
      .optional()
      .describe('Exclude these shows from the results.'),
  }),
  output: episodeSearchOutput,
  async handler(args, ctx) {
    ctx.log('search_episodes', { term: args.term, page: args.page });
    const result = await searchEpisodes(ctx, args);
    const filters = renderFilters(result.filters);
    const outOf = result.totalCount === null ? '' : ` of ${String(result.totalCount)}`;
    const heading =
      result.count === 0
        ? `No episodes on Taddy matching "${args.term}".`
        : `${String(result.count)}${outOf} episode(s) for "${args.term}" (page ${String(result.page)}):`;
    return {
      text: renderList(
        filters ? `${filters}\n${heading}` : heading,
        result.episodes.map((e) => renderEpisodeLine(e)),
      ),
      structured: result,
    };
  },
});
