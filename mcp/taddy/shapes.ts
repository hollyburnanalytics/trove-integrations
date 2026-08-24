import { z } from '@ontrove/extend/toolkit';
import { formatGenre, formatRole } from './enums.ts';
import type {
  ChapterWire,
  PersonWire,
  PodcastEpisodeWire,
  PodcastSeriesWire,
  TranscriptItemWire,
} from './wire.ts';

/**
 * The shapes tools actually return, and the mapping from Taddy's wire types
 * onto them.
 *
 * Three things happen on the way across, all of them because the wire form is
 * built for storage and the output form is read by a model:
 *
 *  - **Epoch seconds become ISO dates.** Taddy dates are Unix timestamps.
 *    `1719792000` tells a reader nothing and invites arithmetic errors;
 *    `2024-07-01` is the same fact, legible, and sorts as text.
 *  - **Genre enums become names.** `PODCASTSERIES_TRUE_CRIME` is the API's
 *    vocabulary; `True Crime` is the answer to "what kind of show is this".
 *  - **Descriptions are capped.** A podcast description is arbitrary
 *    user-generated HTML that regularly runs past a thousand words of sponsor
 *    copy. Uncapped, twenty search hits can cost more context than the answer
 *    is worth, so lists get a short cap and single lookups a generous one.
 */

/** Description budget for an item in a LIST of results. */
const BRIEF_DESCRIPTION_CHARS = 400;

/** Description budget for a single object the caller explicitly asked for. */
const FULL_DESCRIPTION_CHARS = 2500;

/** Convert Taddy's epoch seconds to an ISO date, or null when absent/invalid. */
export function isoDate(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  // Taddy occasionally carries a 0 for "unknown" rather than omitting the field;
  // rendering that as 1970-01-01 would be a confidently wrong publication date.
  if (epochSeconds <= 0) return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : (date.toISOString().split('T', 1)[0] ?? null);
}

/** Render a duration in seconds as `1h 23m` / `9m 05s`, or null. */
export function humanDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes)}m ${String(whole % 60).padStart(2, '0')}s`;
}

/** Render a millisecond timecode as `H:MM:SS` / `M:SS`. */
export function timecode(milliseconds: number | null | undefined): string | null {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${String(hours)}:${String(minutes).padStart(2, '0')}:${secs}`;
  return `${String(minutes)}:${secs}`;
}

/** Collapse whitespace and cap a description, marking any truncation. */
function trimTo(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replaceAll(/\s+/g, ' ').trim();
  if (clean === '') return null;
  return clean.length <= limit ? clean : `${clean.slice(0, limit).trimEnd()}…`;
}

/**
 * `undefined`/`null` → `null`.
 *
 * Nearly every field Taddy returns is optional, and the output contract is
 * explicitly `null` rather than absent. Written inline that is thirty `?? null`
 * operators in one object literal, which reads as noise and trips the
 * complexity ratchet; named once, each field says only which value it carries.
 */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** Drop nulls from a nullable list of nullable strings. */
function definedStrings(values: (string | null | undefined)[] | null | undefined): string[] {
  return (values ?? []).filter((value): value is string => typeof value === 'string');
}

const personSchema = z.object({
  name: z.string(),
  role: z.string().nullable().describe('e.g. "host", "guest".'),
  url: z.string().nullable(),
});

function mapPersons(persons: PersonWire[] | null | undefined): z.infer<typeof personSchema>[] {
  return (persons ?? [])
    .filter((person): person is PersonWire & { name: string } => typeof person.name === 'string')
    .map((person) => ({
      name: person.name,
      role: person.role ? formatRole(person.role) : null,
      url: orNull(person.url),
    }));
}

// --- podcast series ----------------------------------------------------------

export const podcastSchema = z.object({
  uuid: z.string().nullable().describe('Taddy id — pass to get_podcast / get_latest_episodes.'),
  name: z.string(),
  author: z.string().nullable(),
  description: z.string().nullable(),
  genres: z.array(z.string()).describe('Human-readable, e.g. "Society & Culture › Documentary".'),
  language: z.string().nullable(),
  contentType: z.string().nullable().describe('AUDIO or VIDEO.'),
  seriesType: z.string().nullable().describe('EPISODIC or SERIAL.'),
  popularityRank: z.string().nullable().describe('Taddy popularity band, e.g. "TOP_1000".'),
  totalEpisodes: z.number().nullable(),
  datePublished: z.string().nullable(),
  isExplicit: z.boolean().nullable(),
  isCompleted: z.boolean().nullable(),
  /**
   * Surfaced on every series because it decides whether transcripts are
   * available at all: `TRANSCRIBING` means Taddy transcribes every episode of
   * this show automatically, so `get_transcript` will be free and instant.
   */
  transcribeStatus: z
    .string()
    .nullable()
    .describe(
      'TRANSCRIBING = Taddy auto-transcribes every episode of this show. Those are Taddy-generated, ' +
        'so reading one needs a paid plan and spends a transcript credit.',
    ),
  rssUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  itunesId: z.number().nullable(),
  persons: z.array(personSchema),
});

export type Podcast = z.infer<typeof podcastSchema>;

/** Map a wire series to the output shape. `isFull` widens the description cap. */
export function mapPodcast(series: PodcastSeriesWire, isFull = false): Podcast {
  return {
    uuid: orNull(series.uuid),
    name: series.name ?? '(untitled podcast)',
    author: orNull(series.authorName),
    description: trimTo(
      series.description,
      isFull ? FULL_DESCRIPTION_CHARS : BRIEF_DESCRIPTION_CHARS,
    ),
    genres: definedStrings(series.genres).map((genre) => formatGenre(genre)),
    language: orNull(series.language),
    contentType: orNull(series.contentType),
    seriesType: orNull(series.seriesType),
    popularityRank: orNull(series.popularityRank),
    totalEpisodes: orNull(series.totalEpisodesCount),
    datePublished: isoDate(series.datePublished),
    isExplicit: orNull(series.isExplicitContent),
    isCompleted: orNull(series.isCompleted),
    transcribeStatus: orNull(series.taddyTranscribeStatus),
    rssUrl: orNull(series.rssUrl),
    websiteUrl: orNull(series.websiteUrl),
    imageUrl: orNull(series.imageUrl),
    itunesId: orNull(series.itunesId),
    persons: mapPersons(series.persons),
  };
}

// --- episodes ----------------------------------------------------------------

const chapterSchema = z.object({
  title: z.string(),
  startTimecode: z.string().nullable().describe('H:MM:SS from the start of the episode.'),
  startMs: z.number().nullable(),
});

export const episodeSchema = z.object({
  uuid: z.string().nullable().describe('Taddy id — pass to get_episode / get_transcript.'),
  name: z.string(),
  subtitle: z.string().nullable(),
  description: z.string().nullable(),
  datePublished: z.string().nullable(),
  duration: z.string().nullable().describe('Human-readable, e.g. "1h 23m".'),
  durationSeconds: z.number().nullable(),
  episodeNumber: z.number().nullable(),
  seasonNumber: z.number().nullable(),
  episodeType: z.string().nullable().describe('FULL, TRAILER or BONUS.'),
  isExplicit: z.boolean().nullable(),
  isRemoved: z.boolean().nullable().describe('True if pulled from the show’s RSS feed.'),
  /**
   * The single most decision-relevant field on an episode, because it is what
   * `get_transcript` will and will not be able to do without spending a credit.
   */
  transcribeStatus: z
    .string()
    .nullable()
    .describe(
      'COMPLETED = a transcript is ready — but it may be podcast-supplied (free) OR Taddy-generated ' +
        '(paid plan, spends a credit); this field does not distinguish them. ' +
        'PROCESSING / NOT_TRANSCRIBING = nothing stored by Taddy yet.',
    ),
  audioUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  guid: z.string().nullable(),
  podcast: z
    .object({
      uuid: z.string().nullable(),
      name: z.string().nullable(),
      author: z.string().nullable(),
    })
    .nullable(),
  persons: z.array(personSchema),
  chapters: z.array(chapterSchema).nullable(),
});

export type Episode = z.infer<typeof episodeSchema>;

/** Map a wire episode to the output shape. `isFull` widens the description cap. */
export function mapEpisode(episode: PodcastEpisodeWire, isFull = false): Episode {
  const series = episode.podcastSeries;
  return {
    uuid: orNull(episode.uuid),
    name: episode.name ?? '(untitled episode)',
    subtitle: trimTo(episode.subtitle, BRIEF_DESCRIPTION_CHARS),
    description: trimTo(
      episode.description,
      isFull ? FULL_DESCRIPTION_CHARS : BRIEF_DESCRIPTION_CHARS,
    ),
    datePublished: isoDate(episode.datePublished),
    duration: humanDuration(episode.duration),
    durationSeconds: orNull(episode.duration),
    episodeNumber: orNull(episode.episodeNumber),
    seasonNumber: orNull(episode.seasonNumber),
    episodeType: orNull(episode.episodeType),
    isExplicit: orNull(episode.isExplicitContent),
    isRemoved: orNull(episode.isRemoved),
    transcribeStatus: orNull(episode.taddyTranscribeStatus),
    audioUrl: orNull(episode.audioUrl),
    videoUrl: orNull(episode.videoUrl),
    websiteUrl: orNull(episode.websiteUrl),
    imageUrl: orNull(episode.imageUrl),
    guid: orNull(episode.guid),
    podcast: series
      ? {
          uuid: orNull(series.uuid),
          name: orNull(series.name),
          author: orNull(series.authorName),
        }
      : null,
    persons: mapPersons(episode.persons),
    chapters: episode.chapters ? mapChapters(episode.chapters) : null,
  };
}

function mapChapters(chapters: ChapterWire[]): z.infer<typeof chapterSchema>[] {
  return chapters
    .filter(
      (chapter): chapter is ChapterWire & { title: string } => typeof chapter.title === 'string',
    )
    .map((chapter) => ({
      title: chapter.title,
      startTimecode: timecode(chapter.startTimecode),
      startMs: orNull(chapter.startTimecode),
    }));
}

// --- transcripts -------------------------------------------------------------

export const transcriptSegmentSchema = z.object({
  text: z.string(),
  speaker: z.string().nullable(),
  startTimecode: z.string().nullable(),
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/** Map transcript items, dropping segments that carry no text. */
export function mapTranscript(items: TranscriptItemWire[]): TranscriptSegment[] {
  return items
    .filter((item): item is TranscriptItemWire & { text: string } => {
      return typeof item.text === 'string' && item.text.trim() !== '';
    })
    .map((item) => ({
      text: item.text.trim(),
      speaker: orNull(item.speaker),
      startTimecode: timecode(item.startTimecode),
      startMs: orNull(item.startTimecode),
      endMs: orNull(item.endTimecode),
    }));
}
