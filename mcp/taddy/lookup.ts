import { type ToolContext, ToolError, z } from '@ontrove/extend/toolkit';
import { graphql } from './client.ts';
import { exactlyOne } from './params.ts';
import { GET_EPISODE, GET_EPISODE_WITH_CHAPTERS, GET_PODCAST } from './queries.ts';
import { episodeSchema, mapEpisode, mapPodcast, podcastSchema } from './shapes.ts';
import { getPodcastEpisodeWire, getPodcastSeriesWire } from './wire.ts';

/** Single-object lookups: one podcast (with a page of episodes), one episode. */

export const podcastOutput = z.object({
  podcast: podcastSchema,
  episodes: z.array(episodeSchema),
  episodePage: z.number(),
  episodeSort: z.string(),
});

export const episodeOutput = z.object({ episode: episodeSchema });

export interface GetPodcastArgs {
  uuid?: string;
  name?: string;
  rss_url?: string;
  itunes_id?: number;
  episode_page: number;
  episode_limit: number;
  episode_sort: 'LATEST' | 'OLDEST';
  episode_search?: string;
}

/**
 * Fetch one podcast and a page of its episodes.
 *
 * When `episode_search` is given the sort order is forced to `SEARCH`: that is
 * how Taddy switches the `episodes` field from "newest first" to "matching the
 * term", and passing a `searchTerm` alongside `LATEST` silently ignores the
 * term — the caller would get the newest episodes and believe they were matches.
 */
export async function getPodcast(
  ctx: ToolContext,
  args: GetPodcastArgs,
): Promise<z.infer<typeof podcastOutput>> {
  exactlyOne(
    {
      uuid: args.uuid,
      name: args.name,
      rss_url: args.rss_url,
      itunes_id: args.itunes_id,
    },
    'podcast',
  );
  const sortOrder = args.episode_search ? 'SEARCH' : args.episode_sort;
  const data = await graphql(
    ctx,
    GET_PODCAST,
    {
      uuid: args.uuid,
      name: args.name,
      rssUrl: args.rss_url,
      itunesId: args.itunes_id,
      episodePage: args.episode_page,
      episodeLimit: args.episode_limit,
      episodeSort: sortOrder,
      searchTerm: args.episode_search,
    },
    getPodcastSeriesWire,
  );

  const series = data.getPodcastSeries;
  if (!series) {
    throw new ToolError(notFoundMessage(args), { retryable: false });
  }
  return {
    podcast: mapPodcast(series, true),
    episodes: (series.episodes ?? []).map((episode) => mapEpisode(episode)),
    episodePage: args.episode_page,
    episodeSort: sortOrder,
  };
}

/** Say WHICH identifier failed, and what to do about it. */
function notFoundMessage(args: GetPodcastArgs): string {
  if (args.name !== undefined) {
    return `No podcast on Taddy named "${args.name}". Lookup by name is an exact match on the show title — use search_podcasts to find the right one, then pass its uuid.`;
  }
  if (args.rss_url !== undefined) {
    return `No podcast on Taddy with the RSS feed "${args.rss_url}".`;
  }
  if (args.itunes_id !== undefined) {
    return `No podcast on Taddy with iTunes id ${String(args.itunes_id)}.`;
  }
  return `No podcast on Taddy with uuid "${args.uuid ?? ''}".`;
}

export interface GetEpisodeArgs {
  uuid?: string;
  guid?: string;
  name?: string;
  podcast_uuid?: string;
  include_chapters: boolean;
}

/**
 * Fetch one episode.
 *
 * `guid` and `name` are NOT unique on their own — two shows can publish
 * episodes with the same guid, and identical episode titles are common — so
 * either one is only accepted together with `podcast_uuid`, which is what
 * Taddy's `seriesUuidForLookup` exists to disambiguate.
 */
export async function getEpisode(
  ctx: ToolContext,
  args: GetEpisodeArgs,
): Promise<z.infer<typeof episodeOutput>> {
  exactlyOne({ uuid: args.uuid, guid: args.guid, name: args.name }, 'episode');
  if (args.uuid === undefined && args.podcast_uuid === undefined) {
    throw new ToolError(
      'Looking an episode up by guid or name also needs `podcast_uuid` — neither is unique across ' +
        'podcasts, so without it Taddy may return an episode from a different show.',
      { retryable: false },
    );
  }

  const data = await graphql(
    ctx,
    args.include_chapters ? GET_EPISODE_WITH_CHAPTERS : GET_EPISODE,
    {
      uuid: args.uuid,
      guid: args.guid,
      name: args.name,
      seriesUuidForLookup: args.podcast_uuid,
    },
    getPodcastEpisodeWire,
  );

  const episode = data.getPodcastEpisode;
  if (!episode) {
    throw new ToolError('No episode on Taddy matched that identifier.', { retryable: false });
  }
  return { episode: mapEpisode(episode, true) };
}
