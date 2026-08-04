import { type ToolDefinition, z } from '@ontrove/mcp';
import { uuidField } from '../fields.ts';
import { getPodcast, podcastOutput } from '../lookup.ts';
import { renderPodcast } from '../render.ts';

/**
 * `get_podcast` — one show plus a page of its episodes, in one request.
 */
export const getPodcastTool: ToolDefinition = {
  name: 'get_podcast',
  title: 'Taddy: Get podcast',
  description:
    'Full details for ONE podcast plus a page of its episodes, in a single request. Identify ' +
    'the show by uuid (from search_podcasts), exact name, RSS url, or iTunes id — exactly one. ' +
    'Page through the back catalogue with episode_page, or search within the show’s episodes ' +
    'with episode_search.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    uuid: uuidField('Taddy podcast uuid, from search_podcasts.').optional(),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Exact show title. Ambiguous titles resolve to the most popular match.'),
    rss_url: z.string().url().optional().describe('The show’s RSS feed url.'),
    itunes_id: z.number().int().positive().optional().describe('Apple Podcasts id.'),
    episode_page: z.number().int().min(1).max(1000).default(1).describe('Episode page (1–1000).'),
    episode_limit: z
      .number()
      .int()
      .min(0)
      .max(25)
      .default(10)
      .describe('Episodes per page (0–25). Use 0 for show details only.'),
    episode_sort: z
      .enum(['LATEST', 'OLDEST'])
      .default('LATEST')
      .describe('Newest or oldest episodes first. Ignored when episode_search is set.'),
    episode_search: z
      .string()
      .min(1)
      .optional()
      .describe('Filter this show’s episodes by title/description text.'),
  }),
  output: podcastOutput,
  async handler(args, ctx) {
    ctx.log('get_podcast', { uuid: args.uuid, name: args.name });
    const result = await getPodcast(ctx, args);
    return { text: renderPodcast(result.podcast, result.episodes), structured: result };
  },
};
