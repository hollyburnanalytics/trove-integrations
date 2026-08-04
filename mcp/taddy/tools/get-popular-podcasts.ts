import { type ToolDefinition, z } from '@ontrove/mcp';
import { getPopular, popularOutput } from '../discover.ts';
import { renderFilters, renderList, renderPodcastLine } from '../render.ts';

/**
 * `get_popular_podcasts` — Taddy's own standing popularity ranking.
 */
export const getPopularPodcastsTool: ToolDefinition = {
  name: 'get_popular_podcasts',
  title: 'Taddy: Most popular podcasts',
  description:
    'Taddy’s own ranking of the most popular podcasts, optionally within genres and a ' +
    'language. Unlike get_top_charts this is not a single store’s daily chart but Taddy’s ' +
    'standing view across its whole directory — the better answer to "what are the big shows ' +
    'in X" when no particular platform is meant.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    genres: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe('Restrict to these genres, e.g. ["technology"].'),
    language: z.string().min(2).optional().describe('Restrict to one language, e.g. "English".'),
    page: z.number().int().min(1).max(20).default(1).describe('Result page (1–20).'),
    limit: z.number().int().min(1).max(25).default(10).describe('Podcasts per page (1–25).'),
  }),
  output: popularOutput,
  async handler(args, ctx) {
    ctx.log('get_popular_podcasts', { genres: args.genres, language: args.language });
    const result = await getPopular(ctx, args);
    const filters = renderFilters(result.filters);
    const heading =
      result.count === 0
        ? 'No popular podcasts matched those filters.'
        : `${String(result.count)} popular podcast(s) (page ${String(result.page)}):`;
    return {
      text: renderList(
        filters ? `${filters}\n${heading}` : heading,
        result.podcasts.map((p) => renderPodcastLine(p)),
      ),
      structured: result,
    };
  },
};
