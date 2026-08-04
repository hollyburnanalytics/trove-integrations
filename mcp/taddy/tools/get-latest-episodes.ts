import { type ToolDefinition, z } from '@ontrove/mcp';
import { getLatestEpisodes, latestOutput } from '../discover.ts';
import { uuidField } from '../fields.ts';
import { renderEpisodeLine, renderList } from '../render.ts';

/**
 * `get_latest_episodes` — newest episodes across many shows at once.
 */
export const getLatestEpisodesTool: ToolDefinition = {
  name: 'get_latest_episodes',
  title: 'Taddy: Latest episodes across shows',
  description:
    'The newest episodes across MANY podcasts in one request — up to 1000 shows, by uuid or ' +
    'RSS url, newest first. This is the "what’s new across everything I follow" query; polling ' +
    'each show separately would cost one request per show.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    podcast_uuids: z
      .array(uuidField('Podcast uuid.'))
      .max(1000)
      .optional()
      .describe('Shows to pull from, by Taddy uuid.'),
    rss_urls: z
      .array(z.string().url())
      .max(1000)
      .optional()
      .describe('Shows to pull from, by RSS feed url.'),
    page: z.number().int().min(1).max(20).default(1).describe('Result page (1–20).'),
    limit: z.number().int().min(1).max(50).default(25).describe('Episodes per page (1–50).'),
  }),
  output: latestOutput,
  async handler(args, ctx) {
    ctx.log('get_latest_episodes', {
      shows: (args.podcast_uuids?.length ?? 0) + (args.rss_urls?.length ?? 0),
    });
    const result = await getLatestEpisodes(ctx, args);
    const heading =
      result.count === 0
        ? 'No episodes found for those podcasts.'
        : `${String(result.count)} latest episode(s), newest first (page ${String(result.page)}):`;
    return {
      text: renderList(
        heading,
        result.episodes.map((e) => renderEpisodeLine(e)),
      ),
      structured: result,
    };
  },
};
