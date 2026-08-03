import { type ToolContext, ToolError, z } from '@ontrove/mcp';
import { graphql, TRANSCRIPT_TIMEOUT_MS } from './client.ts';
import { GET_TRANSCRIPT } from './queries.ts';
import { mapTranscript, transcriptSegmentSchema } from './shapes.ts';
import { getTranscriptWire } from './wire.ts';

/**
 * Episode transcripts — and the two limits that make this the most careful tool
 * in the toolkit.
 *
 * **1. On-demand transcription costs real money, and Taddy opts you IN.** The
 * API's `useOnDemandCreditsIfNeeded` defaults to `true`: ask for a transcript
 * that does not exist and Taddy will generate one, spending a transcript credit
 * (5c each beyond a plan's monthly allowance) and blocking for ~10 seconds per
 * hour of audio. That default is reasonable for an app whose user pressed a
 * button. It is the wrong default for a tool an agent may call across a page of
 * search results, where the cost is invisible until the bill arrives. So this
 * tool inverts it: `allow_on_demand` is `false` unless the caller says
 * otherwise, and the refusal explains what the option would do.
 *
 * **What that flag does NOT buy you**, and the tool descriptions must not imply
 * otherwise: it governs COMMISSIONING a transcript, not paying for one. Only a
 * transcript the podcast itself publishes is free and unmetered. Anything Taddy
 * generated — including an episode already finished under the automatic
 * top-5000 programme, which reports `COMPLETED` exactly like a podcast-supplied
 * one — requires a paid plan and counts against the monthly allowance whether or
 * not this flag is set. `taddyTranscribeStatus` cannot tell the two apart, so
 * the honest thing is to say so everywhere the status is surfaced rather than
 * let "COMPLETED" read as "free".
 *
 * **2. A transcript is long.** A two-hour episode runs to tens of thousands of
 * words, which is a large fraction of a context window spent in one call. The
 * segments are therefore paged — `segment_offset` / `max_segments` — and the
 * result always says how many segments exist and how to ask for the next page.
 */

export const transcriptOutput = z.object({
  episodeUuid: z.string(),
  style: z.string().describe('PARAGRAPH (grouped) or UTTERANCE (one row per utterance).'),
  totalSegments: z.number(),
  returnedSegments: z.number(),
  segmentOffset: z.number(),
  hasMore: z.boolean(),
  wordCount: z.number(),
  hasSpeakers: z.boolean(),
  usedOnDemandCredit: z
    .boolean()
    .describe('True if on-demand transcription was permitted for this call.'),
  segments: z.array(transcriptSegmentSchema),
});

export interface TranscriptArgs {
  episode_uuid: string;
  style: 'PARAGRAPH' | 'UTTERANCE';
  allow_on_demand: boolean;
  segment_offset: number;
  max_segments: number;
}

/** Fetch (a page of) one episode's transcript. */
export async function getTranscript(
  ctx: ToolContext,
  args: TranscriptArgs,
): Promise<z.infer<typeof transcriptOutput>> {
  const data = await graphql(
    ctx,
    GET_TRANSCRIPT,
    {
      uuid: args.episode_uuid,
      style: args.style,
      // Always sent explicitly. Omitting it would hand control of a paid action
      // back to the upstream's default, which is `true`.
      useOnDemandCreditsIfNeeded: args.allow_on_demand,
    },
    getTranscriptWire,
    // On-demand generation is slow by design (~10s per hour of audio); the
    // standard budget would abort a legitimate long transcription.
    { overallTimeoutMs: args.allow_on_demand ? TRANSCRIPT_TIMEOUT_MS : undefined },
  );

  const all = mapTranscript(data.getEpisodeTranscript ?? []);
  if (all.length === 0) throw emptyTranscriptError(args);

  if (args.segment_offset >= all.length) {
    // Silently returning an empty page renders as "segments 501–500 of 1", which
    // reads as a broken transcript rather than an offset past the end.
    throw new ToolError(
      `segment_offset ${String(args.segment_offset)} is past the end of this transcript, which has ` +
        `${String(all.length)} segment(s).`,
      { retryable: false },
    );
  }
  const page = all.slice(args.segment_offset, args.segment_offset + args.max_segments);
  return {
    episodeUuid: args.episode_uuid,
    style: args.style,
    totalSegments: all.length,
    returnedSegments: page.length,
    segmentOffset: args.segment_offset,
    hasMore: args.segment_offset + page.length < all.length,
    wordCount: page.reduce((sum, segment) => sum + countWords(segment.text), 0),
    hasSpeakers: page.some((segment) => segment.speaker !== null),
    usedOnDemandCredit: args.allow_on_demand,
    segments: page,
  };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * An empty transcript is the expected outcome, not a fault — so say which of the
 * two reasons it was, and what the caller can do next.
 */
function emptyTranscriptError(args: TranscriptArgs): ToolError {
  if (args.allow_on_demand) {
    return new ToolError(
      `Taddy returned no transcript for episode ${args.episode_uuid}, even with on-demand ` +
        'transcription allowed. The episode may have no playable audio, or the account may not be ' +
        'on a plan that includes Taddy-generated transcripts (Pro or Business).',
      { retryable: false },
    );
  }
  return new ToolError(
    `No ready-made transcript for episode ${args.episode_uuid}. The podcast does not supply one and ` +
      'Taddy has not transcribed this episode. Call get_episode to check `transcribeStatus`, or ' +
      'retry with allow_on_demand: true to have Taddy transcribe it now — that spends a transcript ' +
      'credit and needs a paid plan, and takes about 10 seconds per hour of audio.',
    { retryable: false },
  );
}
