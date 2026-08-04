import { type ToolDefinition, z } from '@ontrove/mcp';
import { uuidField } from '../fields.ts';
import { renderTranscript } from '../render.ts';
import { getTranscript, transcriptOutput } from '../transcript.ts';

/**
 * `get_transcript` — an episode transcript, paged, with on-demand transcription opt-in.
 */
export const getTranscriptTool: ToolDefinition = {
  name: 'get_transcript',
  title: 'Taddy: Get episode transcript',
  description:
    'Read an episode’s transcript, with speaker labels and timecodes where the source has ' +
    'them. COST: free only when the PODCAST supplies its own transcript (under 1% of shows). ' +
    'Transcripts Taddy generated itself — including ones already finished for the top ~5000 ' +
    'shows — need a paid plan and count against the account’s monthly transcript allowance; ' +
    '`transcribeStatus: COMPLETED` does NOT tell you which of the two you are getting. If no ' +
    'transcript exists at all, this stops and tells you rather than silently commissioning one ' +
    '— set allow_on_demand: true to permit that. Re-reading the same episode within a billing ' +
    'month is counted once. Long transcripts are paged; follow `hasMore` with segment_offset.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    episode_uuid: uuidField('Taddy episode uuid, from search_episodes or get_podcast.'),
    style: z
      .enum(['PARAGRAPH', 'UTTERANCE'])
      .default('PARAGRAPH')
      .describe(
        'PARAGRAPH groups speech into readable blocks (best for reading). UTTERANCE returns one ' +
          'row per utterance with tighter timecodes (best for quoting a precise moment).',
      ),
    allow_on_demand: z
      .boolean()
      .default(false)
      .describe(
        'Permit Taddy to transcribe the episode now if no transcript exists. This SPENDS a ' +
          'transcript credit from the account’s monthly allowance, requires a paid plan, and ' +
          'takes roughly 10 seconds per hour of audio. Default false.',
      ),
    segment_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Skip this many segments — use with `hasMore` to page a long transcript.'),
    max_segments: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(1200)
      .describe('Max segments returned (1–5000).'),
  }),
  output: transcriptOutput,
  async handler(args, ctx) {
    ctx.log('get_transcript', {
      episode_uuid: args.episode_uuid,
      allow_on_demand: args.allow_on_demand,
    });
    const result = await getTranscript(ctx, args);
    const header =
      `Transcript (${result.style.toLowerCase()}) — segments ${String(result.segmentOffset + 1)}–` +
      `${String(result.segmentOffset + result.returnedSegments)} of ${String(result.totalSegments)}, ` +
      `${String(result.wordCount)} words${result.hasSpeakers ? ', with speakers' : ''}.` +
      (result.hasMore
        ? `\nMore remains — call again with segment_offset: ${String(result.segmentOffset + result.returnedSegments)}.`
        : '');
    return {
      text: `${header}\n\n${renderTranscript(result.segments, { showTimecodes: args.style === 'UTTERANCE' })}`,
      structured: result,
    };
  },
};
