import { z } from '@ontrove/mcp';

/**
 * Lenient Zod schemas for Taddy's GraphQL payloads.
 *
 * Deliberately permissive: almost every field in Taddy's schema is nullable
 * (podcast RSS feeds are user-generated, so a missing `author` or a malformed
 * date is normal, not exceptional). These schemas exist to parse the upstream
 * shape, not to state the tool's contract — the strict shapes live in the
 * `output` schemas on each tool, and the mapping between them is where nulls
 * get normalised.
 */

/** A person credited on a podcast or episode (host, guest, …). */
export const personWire = z.object({
  uuid: z.string().nullish(),
  name: z.string().nullish(),
  role: z.string().nullish(),
  url: z.string().nullish(),
});

/** A chapter marker within an episode. */
export const chapterWire = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  startTimecode: z.number().nullish(),
});

/** One transcript segment: text plus optional speaker and timecodes. */
export const transcriptItemWire = z.object({
  id: z.string().nullish(),
  text: z.string().nullish(),
  speaker: z.string().nullish(),
  startTimecode: z.number().nullish(),
  endTimecode: z.number().nullish(),
});

/** A podcast series. */
export const podcastSeriesWire = z.object({
  uuid: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  imageUrl: z.string().nullish(),
  itunesId: z.number().nullish(),
  rssUrl: z.string().nullish(),
  websiteUrl: z.string().nullish(),
  authorName: z.string().nullish(),
  language: z.string().nullish(),
  genres: z.array(z.string().nullish()).nullish(),
  contentType: z.string().nullish(),
  seriesType: z.string().nullish(),
  popularityRank: z.string().nullish(),
  datePublished: z.number().nullish(),
  totalEpisodesCount: z.number().nullish(),
  isExplicitContent: z.boolean().nullish(),
  isCompleted: z.boolean().nullish(),
  taddyTranscribeStatus: z.string().nullish(),
  persons: z.array(personWire).nullish(),
  episodes: z.array(z.unknown()).nullish(),
});

/**
 * A podcast episode.
 *
 * `podcastSeries` is typed as the series schema but marked optional: an episode
 * fetched via `getPodcastEpisode` carries its parent, an episode nested inside a
 * series query does not (and asking for it there would be a cycle).
 */
export const podcastEpisodeWire = z.object({
  uuid: z.string().nullish(),
  guid: z.string().nullish(),
  name: z.string().nullish(),
  subtitle: z.string().nullish(),
  description: z.string().nullish(),
  audioUrl: z.string().nullish(),
  videoUrl: z.string().nullish(),
  websiteUrl: z.string().nullish(),
  imageUrl: z.string().nullish(),
  datePublished: z.number().nullish(),
  duration: z.number().nullish(),
  episodeNumber: z.number().nullish(),
  seasonNumber: z.number().nullish(),
  episodeType: z.string().nullish(),
  isExplicitContent: z.boolean().nullish(),
  isRemoved: z.boolean().nullish(),
  taddyTranscribeStatus: z.string().nullish(),
  persons: z.array(personWire).nullish(),
  chapters: z.array(chapterWire).nullish(),
  podcastSeries: podcastSeriesWire.nullish(),
});

export type PodcastSeriesWire = z.infer<typeof podcastSeriesWire>;
export type PodcastEpisodeWire = z.infer<typeof podcastEpisodeWire>;
export type TranscriptItemWire = z.infer<typeof transcriptItemWire>;
export type PersonWire = z.infer<typeof personWire>;
export type ChapterWire = z.infer<typeof chapterWire>;

/** `search` — one page of results plus the per-type totals. */
export const searchWire = z.object({
  search: z
    .object({
      searchId: z.string().nullish(),
      podcastSeries: z.array(podcastSeriesWire).nullish(),
      podcastEpisodes: z.array(podcastEpisodeWire).nullish(),
      responseDetails: z
        .array(
          z.object({
            id: z.string().nullish(),
            searchId: z.string().nullish(),
            type: z.string().nullish(),
            totalCount: z.number().nullish(),
            pagesCount: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

/** `getPodcastSeries` — the series, with an optional page of its episodes. */
export const getPodcastSeriesWire = z.object({
  getPodcastSeries: podcastSeriesWire
    .extend({ episodes: z.array(podcastEpisodeWire).nullish() })
    .nullish(),
});

/** `getPodcastEpisode` — one episode plus its parent series. */
export const getPodcastEpisodeWire = z.object({
  getPodcastEpisode: podcastEpisodeWire.nullish(),
});

/** `getEpisodeTranscript` — the transcript segments. */
export const getTranscriptWire = z.object({
  getEpisodeTranscript: z.array(transcriptItemWire).nullish(),
});

/** `getLatestPodcastEpisodes` — newest episodes across many shows. */
export const latestEpisodesWire = z.object({
  getLatestPodcastEpisodes: z.array(podcastEpisodeWire).nullish(),
});

/** `getTopChartsByCountry` / `getTopChartsByGenres`. */
export const topChartsWire = z.object({
  topCharts: z
    .object({
      topChartsId: z.string().nullish(),
      podcastSeries: z.array(podcastSeriesWire).nullish(),
      podcastEpisodes: z.array(podcastEpisodeWire).nullish(),
    })
    .nullish(),
});

/** `getPopularContent` — Taddy's own popularity ranking. */
export const popularWire = z.object({
  getPopularContent: z
    .object({
      popularityRankId: z.string().nullish(),
      podcastSeries: z.array(podcastSeriesWire).nullish(),
    })
    .nullish(),
});

/** `getApiRequestsRemaining` + `getTranscriptCreditsRemaining`. */
export const quotaWire = z.object({
  getApiRequestsRemaining: z.number().nullish(),
  getTranscriptCreditsRemaining: z.number().nullish(),
});
