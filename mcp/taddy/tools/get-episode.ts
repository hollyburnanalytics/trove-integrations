import { type ToolDefinition, z } from '@ontrove/mcp';
import { uuidField } from '../fields.ts';
import { episodeOutput, getEpisode } from '../lookup.ts';
import { renderEpisode } from '../render.ts';

/**
 * `get_episode` — one episode, optionally with chapter markers.
 */
export const getEpisodeTool: ToolDefinition = {
  name: 'get_episode',
  title: 'Taddy: Get episode',
  description:
    'Full details for ONE episode: description, duration, people, audio url, and whether a ' +
    'transcript is ready. Identify it by uuid, or by guid/name together with podcast_uuid ' +
    '(neither is unique on its own). Optionally include chapter markers.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    uuid: uuidField('Taddy episode uuid.').optional(),
    guid: z.string().min(1).optional().describe('The episode’s RSS guid. Needs podcast_uuid.'),
    name: z.string().min(1).optional().describe('Exact episode title. Needs podcast_uuid.'),
    podcast_uuid: uuidField('The show’s uuid — disambiguates guid/name lookups.').optional(),
    include_chapters: z
      .boolean()
      .default(false)
      .describe('Also download and parse the episode’s chapter markers, when it has any.'),
  }),
  output: episodeOutput,
  async handler(args, ctx) {
    ctx.log('get_episode', { uuid: args.uuid, guid: args.guid });
    const result = await getEpisode(ctx, args);
    return { text: renderEpisode(result.episode), structured: result };
  },
};
