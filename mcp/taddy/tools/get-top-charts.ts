import { tool, z } from '@ontrove/extend/toolkit';
import { chartsOutput, getTopCharts } from '../discover.ts';
import { renderEpisodeLine, renderList, renderPodcastLine } from '../render.ts';

/**
 * `get_top_charts` — the Apple Podcasts chart, by country and/or genre.
 */
export const getTopChartsTool = tool({
  name: 'get_top_charts',
  title: 'Taddy: Apple Podcasts top charts',
  description:
    'The Apple Podcasts top charts — the daily ranking, for a country and/or a set of genres. ' +
    'Give `country` to rank a whole country, `genres` to rank within genres, or both to rank a ' +
    'genre inside a country. Set type to PODCASTEPISODE for the episode chart (which always ' +
    'needs a country).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    country: z
      .string()
      .min(2)
      .optional()
      .describe('Country to rank over, e.g. "US", "Canada", "United Kingdom".'),
    genres: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe('Genres to rank within, e.g. ["comedy", "news > politics"].'),
    type: z
      .enum(['PODCASTSERIES', 'PODCASTEPISODE'])
      .default('PODCASTSERIES')
      .describe('Chart of shows, or of individual episodes.'),
    page: z.number().int().min(1).max(20).default(1).describe('Chart page (1–20).'),
    limit: z.number().int().min(1).max(25).default(10).describe('Entries per page (1–25).'),
  }),
  output: chartsOutput,
  async handler(args, ctx) {
    ctx.log('get_top_charts', { country: args.country, genres: args.genres, type: args.type });
    const result = await getTopCharts(ctx, args);
    const lines = [
      ...result.podcasts.map((p) => renderPodcastLine(p)),
      ...result.episodes.map((e) => renderEpisodeLine(e)),
    ];
    const heading =
      result.count === 0
        ? `No Apple Podcasts chart entries for ${result.scope}.`
        : `Apple Podcasts top ${result.type === 'PODCASTSERIES' ? 'shows' : 'episodes'} — ${result.scope} (page ${String(result.page)}):`;
    return { text: renderList(heading, lines), structured: result };
  },
});
