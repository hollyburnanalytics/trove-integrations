import { type ToolContext, ToolError, z } from '@ontrove/extend/toolkit';
import { graphql } from './client.ts';
import { resolveCountry, resolveGenres, resolveLanguage } from './enums.ts';
import { resolvedFiltersSchema } from './params.ts';
import {
  GET_LATEST_EPISODES,
  GET_POPULAR,
  GET_QUOTA,
  TOP_CHARTS_BY_COUNTRY,
  TOP_CHARTS_BY_GENRES,
} from './queries.ts';
import { episodeSchema, mapEpisode, mapPodcast, podcastSchema } from './shapes.ts';
import { latestEpisodesWire, popularWire, quotaWire, topChartsWire } from './wire.ts';

/** Discovery surfaces: charts, popularity, new episodes, and account balances. */

export const chartsOutput = z.object({
  type: z.string(),
  scope: z.string().describe('What the chart was ranked over — a country, or a set of genres.'),
  source: z.string(),
  page: z.number(),
  count: z.number(),
  podcasts: z.array(podcastSchema),
  episodes: z.array(episodeSchema),
});

export interface TopChartsArgs {
  country?: string;
  genres?: string[];
  type: 'PODCASTSERIES' | 'PODCASTEPISODE';
  page: number;
  limit: number;
}

/**
 * Apple Podcasts top charts, by country or by genre.
 *
 * Taddy splits this across two queries and the choice is not cosmetic:
 * `getTopChartsByGenres` ranks within a genre list, `getTopChartsByCountry`
 * ranks a whole country. Supplying `genres` selects the former (with `country`
 * narrowing it), and country alone selects the latter — so the caller expresses
 * what they want ranked rather than which endpoint to call.
 */
export async function getTopCharts(
  ctx: ToolContext,
  args: TopChartsArgs,
): Promise<z.infer<typeof chartsOutput>> {
  const country = args.country === undefined ? undefined : resolveCountry(args.country);
  const genres = args.genres === undefined ? undefined : resolveGenres(args.genres);
  const byGenre = genres !== undefined && genres.length > 0;
  assertChartScope({ country, byGenre, type: args.type });

  const data = await graphql(
    ctx,
    byGenre ? TOP_CHARTS_BY_GENRES : TOP_CHARTS_BY_COUNTRY,
    byGenre
      ? {
          genres,
          taddyType: args.type,
          filterByCountry: country,
          page: args.page,
          limitPerPage: args.limit,
          source: 'APPLE_PODCASTS',
        }
      : {
          country,
          taddyType: args.type,
          page: args.page,
          limitPerPage: args.limit,
          source: 'APPLE_PODCASTS',
        },
    topChartsWire,
  );

  const podcasts = (data.topCharts?.podcastSeries ?? []).map((series) => mapPodcast(series));
  const episodes = (data.topCharts?.podcastEpisodes ?? []).map((episode) => mapEpisode(episode));
  return {
    type: args.type,
    scope: byGenre
      ? `${(genres ?? []).join(', ')}${country ? ` in ${country}` : ''}`
      : (country ?? ''),
    source: 'APPLE_PODCASTS',
    page: args.page,
    count: podcasts.length + episodes.length,
    podcasts,
    episodes,
  };
}

/**
 * Refuse the two chart requests Taddy answers with an empty list.
 *
 * Both would otherwise look like "no results" — a wrong and unactionable
 * answer, since nothing about the query was actually asked.
 */
function assertChartScope(scope: { country?: string; byGenre: boolean; type: string }): void {
  if (!scope.country && !scope.byGenre) {
    throw new ToolError('Give a `country`, or one or more `genres`, to rank over.', {
      retryable: false,
    });
  }
  // Episode charts are only published per country.
  if (scope.byGenre && scope.type === 'PODCASTEPISODE' && !scope.country) {
    throw new ToolError(
      'Episode top charts by genre also need a `country` — Taddy ranks episodes within a country.',
      { retryable: false },
    );
  }
}

export const popularOutput = z.object({
  page: z.number(),
  count: z.number(),
  filters: resolvedFiltersSchema,
  podcasts: z.array(podcastSchema),
});

export interface PopularArgs {
  genres?: string[];
  language?: string;
  page: number;
  limit: number;
}

/**
 * Taddy's own popularity ranking — a different measure from the Apple charts.
 *
 * The Apple chart is a snapshot of a store's ranking on a day; this is Taddy's
 * standing view of what is popular across its directory, and it is the better
 * answer to "what are the big shows in X" when no particular store is meant.
 */
export async function getPopular(
  ctx: ToolContext,
  args: PopularArgs,
): Promise<z.infer<typeof popularOutput>> {
  const genres = args.genres ? resolveGenres(args.genres) : undefined;
  const language = args.language ? resolveLanguage(args.language) : undefined;
  const data = await graphql(
    ctx,
    GET_POPULAR,
    {
      taddyType: 'PODCASTSERIES',
      filterByGenres: genres,
      filterByLanguage: language,
      page: args.page,
      limitPerPage: args.limit,
    },
    popularWire,
  );
  const podcasts = (data.getPopularContent?.podcastSeries ?? []).map((series) =>
    mapPodcast(series),
  );
  return {
    page: args.page,
    count: podcasts.length,
    filters: { genres, languages: language ? [language] : undefined },
    podcasts,
  };
}

export const latestOutput = z.object({
  page: z.number(),
  count: z.number(),
  episodes: z.array(episodeSchema),
});

export interface LatestArgs {
  podcast_uuids?: string[];
  rss_urls?: string[];
  page: number;
  limit: number;
}

/**
 * The newest episodes across many shows at once.
 *
 * This is the "what's new in my subscriptions" query, and it is the reason to
 * keep a list of uuids around: one request covers up to a thousand shows, where
 * polling each show's feed separately would cost a thousand.
 */
export async function getLatestEpisodes(
  ctx: ToolContext,
  args: LatestArgs,
): Promise<z.infer<typeof latestOutput>> {
  const uuids = args.podcast_uuids ?? [];
  const rssUrls = args.rss_urls ?? [];
  if (uuids.length === 0 && rssUrls.length === 0) {
    throw new ToolError('Give `podcast_uuids` and/or `rss_urls` to pull episodes for.', {
      retryable: false,
    });
  }
  const data = await graphql(
    ctx,
    GET_LATEST_EPISODES,
    {
      uuids: uuids.length > 0 ? uuids : undefined,
      rssUrls: rssUrls.length > 0 ? rssUrls : undefined,
      page: args.page,
      limitPerPage: args.limit,
    },
    latestEpisodesWire,
  );
  const episodes = (data.getLatestPodcastEpisodes ?? []).map((episode) => mapEpisode(episode));
  return { page: args.page, count: episodes.length, episodes };
}

export const quotaOutput = z.object({
  apiRequestsRemaining: z.number().nullable(),
  transcriptCreditsRemaining: z.number().nullable(),
});

/**
 * The account's remaining balances.
 *
 * Explicitly NOT cached: the cache is shared across the users an isolate
 * serves, and a quota is the one answer here that is different for each of
 * them. It is also the one answer that is wrong the moment it is reused, since
 * every other call in the session decrements it.
 */
export async function getQuota(ctx: ToolContext): Promise<z.infer<typeof quotaOutput>> {
  const data = await graphql(ctx, GET_QUOTA, {}, quotaWire, { cacheable: false });
  return {
    apiRequestsRemaining: data.getApiRequestsRemaining ?? null,
    transcriptCreditsRemaining: data.getTranscriptCreditsRemaining ?? null,
  };
}
