import type { ToolContext } from '@ontrove/extend/toolkit';
import { z } from '@ontrove/extend/toolkit';
import { graphql } from './client.ts';
import {
  assertRange,
  commonSearchVariables,
  epochSeconds,
  resolvedFilters,
  resolvedFiltersSchema,
  totalFor,
} from './params.ts';
import { SEARCH_EPISODES, SEARCH_PODCASTS } from './queries.ts';
import { episodeSchema, mapEpisode, mapPodcast, podcastSchema } from './shapes.ts';
import { searchWire } from './wire.ts';

/** Search over podcast series and over episodes. */

export const podcastSearchOutput = z.object({
  term: z.string(),
  page: z.number(),
  totalCount: z
    .number()
    .nullable()
    .describe('Total matches across all pages, when Taddy reports it.'),
  count: z.number(),
  filters: resolvedFiltersSchema,
  podcasts: z.array(podcastSchema),
});

export const episodeSearchOutput = z.object({
  term: z.string(),
  page: z.number(),
  totalCount: z.number().nullable(),
  count: z.number(),
  filters: resolvedFiltersSchema,
  episodes: z.array(episodeSchema),
});

export type PodcastSearchArgs = Parameters<typeof commonSearchVariables>[0] & {
  term: string;
  updated_after?: string;
  min_episodes?: number;
  max_episodes?: number;
};

export type EpisodeSearchArgs = Parameters<typeof commonSearchVariables>[0] & {
  term: string;
  min_duration_seconds?: number;
  max_duration_seconds?: number;
  has_transcript?: boolean;
  podcast_uuids?: string[];
  exclude_podcast_uuids?: string[];
};

/** Search podcast series. */
export async function searchPodcasts(
  ctx: ToolContext,
  args: PodcastSearchArgs,
): Promise<z.infer<typeof podcastSearchOutput>> {
  assertRange(args.published_after, args.published_before, 'published_after/published_before');
  // Strict: Taddy's episode-count filters are `greaterThan`/`lessThan`, so an
  // equal pair (min 5 / max 5) also selects nothing.
  assertRange(args.min_episodes, args.max_episodes, 'min_episodes/max_episodes', { strict: true });
  const common = commonSearchVariables(args);
  const data = await graphql(
    ctx,
    SEARCH_PODCASTS,
    {
      term: args.term,
      ...common,
      lastUpdatedAfter: epochSeconds(args.updated_after),
      totalEpisodesGreaterThan: args.min_episodes,
      totalEpisodesLessThan: args.max_episodes,
    },
    searchWire,
  );
  const hits = data.search?.podcastSeries ?? [];
  const podcasts = hits.map((hit) => mapPodcast(hit));
  return {
    term: args.term,
    page: args.page,
    totalCount: totalFor(data.search?.responseDetails, 'PODCASTSERIES'),
    count: podcasts.length,
    filters: resolvedFilters(common),
    podcasts,
  };
}

/** Search podcast episodes. */
export async function searchEpisodes(
  ctx: ToolContext,
  args: EpisodeSearchArgs,
): Promise<z.infer<typeof episodeSearchOutput>> {
  assertRange(args.published_after, args.published_before, 'published_after/published_before');
  assertRange(
    args.min_duration_seconds,
    args.max_duration_seconds,
    'min_duration_seconds/max_duration_seconds',
    { strict: true },
  );
  const common = commonSearchVariables(args);
  const data = await graphql(
    ctx,
    SEARCH_EPISODES,
    {
      term: args.term,
      ...common,
      durationGreaterThan: args.min_duration_seconds,
      durationLessThan: args.max_duration_seconds,
      hasTranscript: args.has_transcript,
      seriesUuids: args.podcast_uuids,
      notInSeriesUuids: args.exclude_podcast_uuids,
    },
    searchWire,
  );
  const hits = data.search?.podcastEpisodes ?? [];
  const episodes = hits.map((hit) => mapEpisode(hit));
  return {
    term: args.term,
    page: args.page,
    totalCount: totalFor(data.search?.responseDetails, 'PODCASTEPISODE'),
    count: episodes.length,
    filters: resolvedFilters(common),
    episodes,
  };
}
