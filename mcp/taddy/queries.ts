/**
 * The GraphQL documents this toolkit sends, and the field selections they share.
 *
 * **Selections are budgets, not wish-lists.** GraphQL charges nothing extra for
 * breadth, but the context window does, and Taddy's free tier is 500 requests a
 * MONTH — so each document asks for one screenful of genuinely useful fields and
 * leaves the rest. Two selections exist per entity for that reason: a compact
 * one for list results (search hits, chart entries) and a full one for the
 * single-object lookups where the caller has already said which item they want.
 *
 * Every document is parameterised. Nothing is interpolated into a query string,
 * so no caller-supplied value can reshape the document it travels in.
 */

/** Series fields for LIST results — enough to choose one, no more. */
const SERIES_BRIEF = `
  uuid
  name
  authorName
  description(shouldStripHtmlTags: true)
  imageUrl
  rssUrl
  itunesId
  genres
  language
  contentType
  popularityRank
  totalEpisodesCount
  isExplicitContent
  taddyTranscribeStatus
`;

/** Series fields for a single-object lookup. */
const SERIES_FULL = `
  ${SERIES_BRIEF}
  websiteUrl
  seriesType
  datePublished
  isCompleted
  persons { uuid name role url }
`;

/** Episode fields for LIST results. */
const EPISODE_BRIEF = `
  uuid
  guid
  name
  subtitle
  datePublished
  duration
  episodeNumber
  seasonNumber
  episodeType
  audioUrl
  websiteUrl
  isExplicitContent
  taddyTranscribeStatus
`;

/** Episode fields for a single-object lookup, parent series included. */
const EPISODE_FULL = `
  ${EPISODE_BRIEF}
  description(shouldStripHtmlTags: true)
  imageUrl
  videoUrl
  isRemoved
  persons { uuid name role url }
  podcastSeries { uuid name authorName rssUrl itunesId taddyTranscribeStatus }
`;

/**
 * `search`, restricted to podcast series.
 *
 * The series and episode searches are separate documents even though Taddy
 * exposes one `search` field for both. The filters are not interchangeable —
 * Taddy answers a duration filter on a series search with an empty array rather
 * than an error — so one merged tool would offer arguments that silently return
 * nothing. Splitting them makes each tool's arguments exactly the ones that work.
 */
export const SEARCH_PODCASTS = `
query SearchPodcasts(
  $term: String!
  $page: Int
  $limitPerPage: Int
  $sortBy: SearchSortOrder
  $matchBy: SearchMatchType
  $isSafeMode: Boolean
  $genres: [Genre]
  $languages: [Language]
  $countries: [Country]
  $contentType: [PodcastContentType]
  $publishedAfter: Int
  $publishedBefore: Int
  $lastUpdatedAfter: Int
  $totalEpisodesGreaterThan: Int
  $totalEpisodesLessThan: Int
) {
  search(
    term: $term
    page: $page
    limitPerPage: $limitPerPage
    sortBy: $sortBy
    matchBy: $matchBy
    isSafeMode: $isSafeMode
    filterForTypes: [PODCASTSERIES]
    filterForGenres: $genres
    filterForLanguages: $languages
    filterForCountries: $countries
    filterForPodcastContentType: $contentType
    filterForPublishedAfter: $publishedAfter
    filterForPublishedBefore: $publishedBefore
    filterForLastUpdatedAfter: $lastUpdatedAfter
    filterForTotalEpisodesGreaterThan: $totalEpisodesGreaterThan
    filterForTotalEpisodesLessThan: $totalEpisodesLessThan
  ) {
    searchId
    responseDetails { id type totalCount pagesCount }
    podcastSeries { ${SERIES_BRIEF} }
  }
}`;

/** `search`, restricted to podcast episodes (duration + transcript filters). */
export const SEARCH_EPISODES = `
query SearchEpisodes(
  $term: String!
  $page: Int
  $limitPerPage: Int
  $sortBy: SearchSortOrder
  $matchBy: SearchMatchType
  $isSafeMode: Boolean
  $genres: [Genre]
  $languages: [Language]
  $countries: [Country]
  $contentType: [PodcastContentType]
  $publishedAfter: Int
  $publishedBefore: Int
  $durationGreaterThan: Int
  $durationLessThan: Int
  $hasTranscript: Boolean
  $seriesUuids: [ID]
  $notInSeriesUuids: [ID]
) {
  search(
    term: $term
    page: $page
    limitPerPage: $limitPerPage
    sortBy: $sortBy
    matchBy: $matchBy
    isSafeMode: $isSafeMode
    filterForTypes: [PODCASTEPISODE]
    filterForGenres: $genres
    filterForLanguages: $languages
    filterForCountries: $countries
    filterForPodcastContentType: $contentType
    filterForPublishedAfter: $publishedAfter
    filterForPublishedBefore: $publishedBefore
    filterForDurationGreaterThan: $durationGreaterThan
    filterForDurationLessThan: $durationLessThan
    filterForHasTranscript: $hasTranscript
    filterForSeriesUuids: $seriesUuids
    filterForNotInSeriesUuids: $notInSeriesUuids
  ) {
    searchId
    responseDetails { id type totalCount pagesCount }
    podcastEpisodes {
      ${EPISODE_BRIEF}
      description(shouldStripHtmlTags: true)
      podcastSeries { uuid name authorName }
    }
  }
}`;

/**
 * `getPodcastSeries` with one page of episodes.
 *
 * Series and episodes in ONE request is the whole reason to prefer GraphQL here:
 * the REST-shaped alternative (look up the show, then list its episodes) costs
 * two of the account's 500 monthly requests to answer one question.
 */
export const GET_PODCAST = `
query GetPodcast(
  $uuid: ID
  $name: String
  $rssUrl: String
  $itunesId: Int
  $episodePage: Int
  $episodeLimit: Int
  $episodeSort: SortOrder
  $searchTerm: String
) {
  getPodcastSeries(uuid: $uuid, name: $name, rssUrl: $rssUrl, itunesId: $itunesId) {
    ${SERIES_FULL}
    episodes(
      page: $episodePage
      limitPerPage: $episodeLimit
      sortOrder: $episodeSort
      searchTerm: $searchTerm
    ) { ${EPISODE_BRIEF} }
  }
}`;

/** `getPodcastEpisode`, optionally with chapter markers. */
export const GET_EPISODE = `
query GetEpisode($uuid: ID, $guid: String, $name: String, $seriesUuidForLookup: ID) {
  getPodcastEpisode(
    uuid: $uuid
    guid: $guid
    name: $name
    seriesUuidForLookup: $seriesUuidForLookup
  ) { ${EPISODE_FULL} }
}`;

/** `getPodcastEpisode` including parsed chapter markers. */
export const GET_EPISODE_WITH_CHAPTERS = `
query GetEpisodeWithChapters($uuid: ID, $guid: String, $name: String, $seriesUuidForLookup: ID) {
  getPodcastEpisode(
    uuid: $uuid
    guid: $guid
    name: $name
    seriesUuidForLookup: $seriesUuidForLookup
  ) {
    ${EPISODE_FULL}
    chapters { id title startTimecode }
  }
}`;

/**
 * `getEpisodeTranscript` — the standalone transcript query.
 *
 * Taddy's docs recommend this over selecting `transcript` on an episode: when a
 * transcript has to be generated on demand the request blocks for as long as it
 * takes, and asking through the episode would hold the episode's own metadata
 * hostage behind it. Split, the metadata lookup stays fast.
 */
export const GET_TRANSCRIPT = `
query GetTranscript(
  $uuid: ID!
  $style: TranscriptItemStyle
  $useOnDemandCreditsIfNeeded: Boolean
) {
  getEpisodeTranscript(
    uuid: $uuid
    style: $style
    useOnDemandCreditsIfNeeded: $useOnDemandCreditsIfNeeded
  ) { id text speaker startTimecode endTimecode }
}`;

/** `getLatestPodcastEpisodes` — newest episodes across up to 1000 shows. */
export const GET_LATEST_EPISODES = `
query GetLatestEpisodes($uuids: [ID], $rssUrls: [String], $page: Int, $limitPerPage: Int) {
  getLatestPodcastEpisodes(
    uuids: $uuids
    rssUrls: $rssUrls
    page: $page
    limitPerPage: $limitPerPage
  ) {
    ${EPISODE_BRIEF}
    description(shouldStripHtmlTags: true)
    podcastSeries { uuid name authorName }
  }
}`;

/**
 * `getTopChartsByCountry`, aliased to `topCharts`.
 *
 * The alias lets both chart queries share one response schema, since the two
 * upstream fields return the identical `TopChartsResults` type.
 */
export const TOP_CHARTS_BY_COUNTRY = `
query TopChartsByCountry(
  $country: Country!
  $taddyType: TaddyType!
  $page: Int
  $limitPerPage: Int
  $source: TopChartsSource
) {
  topCharts: getTopChartsByCountry(
    country: $country
    taddyType: $taddyType
    page: $page
    limitPerPage: $limitPerPage
    source: $source
  ) {
    topChartsId
    podcastSeries { ${SERIES_BRIEF} }
    podcastEpisodes { ${EPISODE_BRIEF} podcastSeries { uuid name authorName } }
  }
}`;

/** `getTopChartsByGenres`, aliased to `topCharts` for the same reason. */
export const TOP_CHARTS_BY_GENRES = `
query TopChartsByGenres(
  $genres: [Genre!]
  $taddyType: TaddyType!
  $filterByCountry: Country
  $page: Int
  $limitPerPage: Int
  $source: TopChartsSource
) {
  topCharts: getTopChartsByGenres(
    genres: $genres
    taddyType: $taddyType
    filterByCountry: $filterByCountry
    page: $page
    limitPerPage: $limitPerPage
    source: $source
  ) {
    topChartsId
    podcastSeries { ${SERIES_BRIEF} }
    podcastEpisodes { ${EPISODE_BRIEF} podcastSeries { uuid name authorName } }
  }
}`;

/** `getPopularContent` — Taddy's own popularity ranking, not Apple's chart. */
export const GET_POPULAR = `
query GetPopular(
  $taddyType: TaddyType
  $filterByGenres: [Genre!]
  $filterByLanguage: Language
  $page: Int
  $limitPerPage: Int
) {
  getPopularContent(
    taddyType: $taddyType
    filterByGenres: $filterByGenres
    filterByLanguage: $filterByLanguage
    page: $page
    limitPerPage: $limitPerPage
  ) {
    popularityRankId
    podcastSeries { ${SERIES_BRIEF} }
  }
}`;

/** Both remaining-balance counters in a single request. */
export const GET_QUOTA = `
query GetQuota {
  getApiRequestsRemaining
  getTranscriptCreditsRemaining
}`;
