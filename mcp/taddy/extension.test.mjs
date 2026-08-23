import { describe, expect, it } from 'vitest';
import { callTool } from '../lib/test-harness.mjs';
import { formatGenre, formatRole, resolveCountry, resolveGenre, resolveLanguage } from './enums.ts';
import server from './extension.ts';
import { humanDuration, isoDate, timecode } from './shapes.ts';

/**
 * Fixtures mirror the shapes Taddy's GraphQL API actually returns.
 *
 * NOTE ON CACHING: the client keeps an in-isolate response cache keyed on the
 * request BODY (and salted with the user id), so two tests issuing the identical
 * query would have the second served from cache and never reach the mock. Every
 * test below therefore varies something in its arguments.
 */

/** A real `null` value derived without a `null` literal (unicorn/no-null). */
const NULL = JSON.parse('null');

const SECRETS = { TADDY_USER_ID: '7', TADDY_API_KEY: 'test-key' };

/**
 * Build a responder that answers the SDK's secret callback per secret name and
 * delegates everything else to `onQuery(variables, query, init)`.
 *
 * Taddy answers a rejected query with HTTP 200 and an `errors` array, so
 * `onQuery` may return `{ errors: [...] }` to exercise that path.
 */
function taddy(onQuery, overrides = {}) {
  const secrets = overrides.secrets ?? SECRETS;
  const calls = [];
  const responder = (url, init) => {
    if (url.includes('/internal/secret')) {
      const name = JSON.parse(init?.body ?? '{}').name;
      return { json: { value: secrets[name] ?? '' } };
    }
    const body = JSON.parse(init?.body ?? '{}');
    calls.push({ url, init, query: body.query, variables: body.variables });
    const result = onQuery(body.variables ?? {}, body.query ?? '', init);
    if (result && (result.errors || result.data !== undefined)) return { json: result };
    return { json: { data: result } };
  };
  responder.calls = calls;
  return responder;
}

const SERIES = {
  uuid: '6bdfd429-f58b-427d-8072-353d478aa15f',
  name: 'Build Your SaaS',
  authorName: 'Jon Buda & Justin Jackson',
  // Already tag-free: every description is requested with
  // `shouldStripHtmlTags: true`, so Taddy strips the markup server-side. The
  // doubled spaces are what survives that, and what `trimTo` collapses.
  description: 'A podcast about  building software businesses.',
  imageUrl: 'https://ax0.taddy.org/byss.jpg',
  rssUrl: 'https://feeds.transistor.fm/build-your-saas',
  itunesId: 1_155_636_484,
  genres: ['PODCASTSERIES_TECHNOLOGY', 'PODCASTSERIES_BUSINESS_ENTREPRENEURSHIP'],
  language: 'ENGLISH',
  contentType: 'AUDIO',
  seriesType: 'EPISODIC',
  popularityRank: 'TOP_5000',
  totalEpisodesCount: 212,
  isExplicitContent: false,
  isCompleted: false,
  taddyTranscribeStatus: 'TRANSCRIBING',
  datePublished: 1_472_688_000,
  persons: [{ uuid: 'p1', name: 'Justin Jackson', role: 'host', url: 'https://justinjackson.ca' }],
};

const EPISODE = {
  uuid: 'e03bf3ef-829e-4f47-9f02-29ac6a747b4f',
  guid: 'byss-212',
  name: 'Shipping the thing',
  subtitle: 'On finishing what you start.',
  description: 'We talk about   shipping.',
  datePublished: 1_719_792_000,
  duration: 4980,
  episodeNumber: 212,
  seasonNumber: 3,
  episodeType: 'FULL',
  audioUrl: 'https://media.transistor.fm/byss-212.mp3',
  websiteUrl: 'https://saas.transistor.fm/212',
  isExplicitContent: false,
  isRemoved: false,
  taddyTranscribeStatus: 'COMPLETED',
};

describe('search_podcasts', () => {
  it('returns shows with uuids, formatted genres and totals', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'saas', limit: 5 },
      taddy(() => ({
        search: {
          searchId: 's1',
          responseDetails: [{ type: 'PODCASTSERIES', totalCount: 42, pagesCount: 5 }],
          podcastSeries: [SERIES],
        },
      })),
    );
    expect(result.ok).toBe(true);
    const { structured, text } = result.result;
    expect(structured.count).toBe(1);
    expect(structured.totalCount).toBe(42);
    expect(structured.podcasts[0].uuid).toBe(SERIES.uuid);
    // Genre enums are presented as names, not as API vocabulary.
    expect(structured.podcasts[0].genres).toEqual(['Technology', 'Business › Entrepreneurship']);
    // Runs of whitespace are collapsed.
    expect(structured.podcasts[0].description).toBe(
      'A podcast about building software businesses.',
    );
    expect(text).toContain('1 of 42 podcast(s)');
    expect(text).toContain(SERIES.uuid);
    expect(text).toContain('auto-transcribed');
  });

  it('resolves friendly genre/language/country names into Taddy enums', async () => {
    const responder = taddy(() => ({ search: { searchId: 's2', podcastSeries: [] } }));
    const result = await callTool(
      server,
      'search_podcasts',
      {
        term: 'mental health',
        genres: ['health & fitness > mental health', 'true crime'],
        languages: ['en'],
        countries: ['US'],
        published_after: '2024-01-01',
      },
      responder,
    );
    expect(result.ok).toBe(true);
    const { variables } = responder.calls.at(-1);
    expect(variables.genres).toEqual([
      'PODCASTSERIES_HEALTH_AND_FITNESS_MENTAL_HEALTH',
      'PODCASTSERIES_TRUE_CRIME',
    ]);
    expect(variables.languages).toEqual(['ENGLISH']);
    expect(variables.countries).toEqual(['UNITED_STATES_OF_AMERICA']);
    // ISO dates cross the boundary as epoch seconds.
    expect(variables.publishedAfter).toBe(1_704_067_200);
  });

  it('rejects an unknown genre with the closest real values, before spending a request', async () => {
    // No responder: the vocabulary is checked before any egress, so a bad genre
    // must never cost one of the account's 500 monthly requests.
    const result = await callTool(server, 'search_podcasts', {
      term: 'x',
      genres: ['sports betting'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a Taddy genre');
    expect(result.error).toContain('PODCASTSERIES_SPORTS');
  });

  it('accepts a genre named by its leaf alone', async () => {
    const responder = taddy(() => ({ search: { searchId: 's-leaf', podcastSeries: [] } }));
    await callTool(server, 'search_podcasts', { term: 'money', genres: ['investing'] }, responder);
    expect(responder.calls.at(-1).variables.genres).toEqual(['PODCASTSERIES_BUSINESS_INVESTING']);
  });
});

describe('search_episodes', () => {
  it('passes episode-only filters through and returns episode uuids', async () => {
    const responder = taddy(() => ({
      search: {
        searchId: 's3',
        responseDetails: [{ type: 'PODCASTEPISODE', totalCount: 9 }],
        podcastEpisodes: [{ ...EPISODE, podcastSeries: { uuid: SERIES.uuid, name: SERIES.name } }],
      },
    }));
    const result = await callTool(
      server,
      'search_episodes',
      { term: 'shipping', has_transcript: true, min_duration_seconds: 1800 },
      responder,
    );
    expect(result.ok).toBe(true);
    const { variables } = responder.calls.at(-1);
    expect(variables.hasTranscript).toBe(true);
    expect(variables.durationGreaterThan).toBe(1800);
    const episode = result.result.structured.episodes[0];
    expect(episode.uuid).toBe(EPISODE.uuid);
    expect(episode.duration).toBe('1h 23m');
    expect(episode.datePublished).toBe('2024-07-01');
    expect(result.result.text).toContain('transcript ready');
  });
});

describe('get_podcast', () => {
  it('returns the show and its episodes from a single request', async () => {
    const responder = taddy(() => ({
      getPodcastSeries: { ...SERIES, episodes: [EPISODE] },
    }));
    const result = await callTool(server, 'get_podcast', { uuid: SERIES.uuid }, responder);
    expect(result.ok).toBe(true);
    // One request, not two: the whole point of the GraphQL shape.
    expect(responder.calls.filter((c) => c.query)).toHaveLength(1);
    const { structured, text } = result.result;
    expect(structured.podcast.name).toBe('Build Your SaaS');
    expect(structured.episodes).toHaveLength(1);
    expect(text).toContain('auto-transcribes every episode');
  });

  it('forces SEARCH sort order when episode_search is given', async () => {
    const responder = taddy(() => ({ getPodcastSeries: { ...SERIES, episodes: [] } }));
    await callTool(
      server,
      'get_podcast',
      { uuid: SERIES.uuid, episode_search: 'pricing', episode_sort: 'LATEST' },
      responder,
    );
    const { variables } = responder.calls.at(-1);
    expect(variables.episodeSort).toBe('SEARCH');
    expect(variables.searchTerm).toBe('pricing');
  });

  it('requires exactly one identifier', async () => {
    const both = await callTool(server, 'get_podcast', {
      uuid: SERIES.uuid,
      name: 'Build Your SaaS',
    });
    expect(both.ok).toBe(false);
    expect(both.error).toContain('exactly ONE');

    const neither = await callTool(server, 'get_podcast', {});
    expect(neither.ok).toBe(false);
    expect(neither.error).toContain('one way to identify');
  });

  it('explains a name miss rather than reporting a bare not-found', async () => {
    const result = await callTool(
      server,
      'get_podcast',
      { name: 'A Show That Does Not Exist' },
      taddy(() => ({ getPodcastSeries: NULL })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exact match');
    expect(result.error).toContain('search_podcasts');
  });
});

describe('get_episode', () => {
  it('refuses a guid lookup without podcast_uuid, before spending a request', async () => {
    const result = await callTool(server, 'get_episode', { guid: 'byss-212' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('podcast_uuid');
  });

  it('includes chapters only when asked', async () => {
    const withChapters = taddy(() => ({
      getPodcastEpisode: {
        ...EPISODE,
        chapters: [
          { id: 'c1', title: 'Intro', startTimecode: 0 },
          { id: 'c2', title: 'Pricing', startTimecode: 3_723_000 },
        ],
      },
    }));
    const result = await callTool(
      server,
      'get_episode',
      { uuid: EPISODE.uuid, include_chapters: true },
      withChapters,
    );
    expect(result.ok).toBe(true);
    expect(withChapters.calls.at(-1).query).toContain('chapters');
    expect(result.result.structured.episode.chapters).toHaveLength(2);
    expect(result.result.text).toContain('1:02:03  Pricing');

    const plain = taddy(() => ({ getPodcastEpisode: EPISODE }));
    await callTool(server, 'get_episode', { uuid: EPISODE.uuid }, plain);
    expect(plain.calls.at(-1).query).not.toContain('chapters');
  });
});

describe('get_transcript', () => {
  const SEGMENTS = [
    { id: '1', text: 'Welcome back.', speaker: 'Justin', startTimecode: 0, endTimecode: 2000 },
    { id: '2', text: 'Glad to be here.', speaker: 'Jon', startTimecode: 2000, endTimecode: 4000 },
    { id: '3', text: 'So, shipping.', speaker: 'Jon', startTimecode: 4000, endTimecode: 6000 },
  ];

  it('does NOT permit on-demand transcription by default', async () => {
    const responder = taddy(() => ({ getEpisodeTranscript: SEGMENTS }));
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: EPISODE.uuid },
      responder,
    );
    expect(result.ok).toBe(true);
    // The upstream default is TRUE, so sending false explicitly is the whole point.
    expect(responder.calls.at(-1).variables.useOnDemandCreditsIfNeeded).toBe(false);
    expect(result.result.structured.usedOnDemandCredit).toBe(false);
  });

  it('repeats a speaker label only when the speaker changes', async () => {
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: '11111111-1111-4111-8111-111111111111', style: 'UTTERANCE' },
      taddy(() => ({ getEpisodeTranscript: SEGMENTS })),
    );
    expect(result.ok).toBe(true);
    const { text, structured } = result.result;
    expect(structured.hasSpeakers).toBe(true);
    expect(text.match(/^Jon:$/gm)).toHaveLength(1);
    expect(text).toContain('[0:04] So, shipping.');
  });

  it('pages long transcripts and says how to continue', async () => {
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: '22222222-2222-4222-8222-222222222222', max_segments: 2 },
      taddy(() => ({ getEpisodeTranscript: SEGMENTS })),
    );
    expect(result.ok).toBe(true);
    const { structured, text } = result.result;
    expect(structured.totalSegments).toBe(3);
    expect(structured.returnedSegments).toBe(2);
    expect(structured.hasMore).toBe(true);
    expect(text).toContain('segment_offset: 2');
  });

  it('tells the caller how to get a missing transcript instead of just failing', async () => {
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: '33333333-3333-4333-8333-333333333333' },
      taddy(() => ({ getEpisodeTranscript: [] })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('allow_on_demand: true');
    expect(result.error).toContain('credit');
  });
});

describe('get_top_charts', () => {
  it('uses the by-country query when only a country is given', async () => {
    const responder = taddy(() => ({ topCharts: { topChartsId: 't1', podcastSeries: [SERIES] } }));
    const result = await callTool(server, 'get_top_charts', { country: 'Canada' }, responder);
    expect(result.ok).toBe(true);
    const call = responder.calls.at(-1);
    expect(call.query).toContain('getTopChartsByCountry');
    expect(call.variables.country).toBe('CANADA');
    expect(result.result.text).toContain('Apple Podcasts top shows');
  });

  it('uses the by-genre query when genres are given', async () => {
    const responder = taddy(() => ({ topCharts: { topChartsId: 't2', podcastSeries: [] } }));
    await callTool(server, 'get_top_charts', { genres: ['comedy'], country: 'US' }, responder);
    const call = responder.calls.at(-1);
    expect(call.query).toContain('getTopChartsByGenres');
    expect(call.variables.genres).toEqual(['PODCASTSERIES_COMEDY']);
    expect(call.variables.filterByCountry).toBe('UNITED_STATES_OF_AMERICA');
  });

  it('renders an episode chart, which carries shows on each entry', async () => {
    const result = await callTool(
      server,
      'get_top_charts',
      { country: 'Australia', type: 'PODCASTEPISODE' },
      taddy(() => ({
        topCharts: {
          topChartsId: 't3',
          podcastEpisodes: [
            { ...EPISODE, podcastSeries: { uuid: SERIES.uuid, name: SERIES.name } },
          ],
        },
      })),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.episodes).toHaveLength(1);
    expect(result.result.text).toContain('Apple Podcasts top episodes');
    expect(result.result.text).toContain(EPISODE.uuid);
  });

  it('refuses a genre-only episode chart, which would return nothing', async () => {
    const result = await callTool(server, 'get_top_charts', {
      genres: ['comedy'],
      type: 'PODCASTEPISODE',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('country');
  });

  it('requires something to rank over', async () => {
    const result = await callTool(server, 'get_top_charts', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('country');
  });
});

describe('get_latest_episodes', () => {
  it('pulls many shows in one request', async () => {
    const responder = taddy(() => ({ getLatestPodcastEpisodes: [EPISODE] }));
    const result = await callTool(
      server,
      'get_latest_episodes',
      { podcast_uuids: [SERIES.uuid], limit: 5 },
      responder,
    );
    expect(result.ok).toBe(true);
    expect(responder.calls.at(-1).variables.uuids).toEqual([SERIES.uuid]);
    expect(result.result.structured.count).toBe(1);
  });

  it('requires at least one show', async () => {
    const result = await callTool(server, 'get_latest_episodes', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('podcast_uuids');
  });
});

describe('check_quota', () => {
  it('reports both balances and is never served from cache', async () => {
    let remaining = 480;
    const responder = taddy(() => ({
      getApiRequestsRemaining: remaining--,
      getTranscriptCreditsRemaining: 0,
    }));
    const first = await callTool(server, 'check_quota', {}, responder);
    expect(first.ok).toBe(true);
    expect(first.result.structured.apiRequestsRemaining).toBe(480);
    expect(first.result.text).toContain('Transcript credits remaining: 0');

    // A cached quota would be stale the moment it was stored, so the second call
    // must reach the upstream again.
    const second = await callTool(server, 'check_quota', {}, responder);
    expect(second.result.structured.apiRequestsRemaining).toBe(479);
  });
});

describe('GraphQL error handling', () => {
  it('maps an invalid key to a clear, non-retryable error', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'auth-failure-probe' },
      taddy(() => ({ errors: [{ code: 'API_KEY_INVALID', message: 'bad key' }], data: NULL })),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('TADDY_USER_ID');
  });

  it('maps an exhausted monthly quota to a non-retryable error', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'quota-probe' },
      taddy(() => ({
        errors: [{ code: 'API_RATE_LIMIT_EXCEEDED', message: 'monthly limit reached' }],
      })),
    );
    expect(result.ok).toBe(false);
    // Retrying a blown MONTHLY quota is pointless; saying otherwise would be a lie.
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('500 requests/month');
  });

  it('maps a Taddy server fault to a retryable error', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'server-fault-probe' },
      taddy(() => ({ errors: [{ code: 'TADDY_SERVER_ERROR', message: 'oops' }] })),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('surfaces a plan restriction as such', async () => {
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: '44444444-4444-4444-8444-444444444444', allow_on_demand: true },
      taddy(() => ({
        errors: [{ code: 'ACCESS_NOT_ALLOWED', message: 'transcripts need a paid plan' }],
      })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('paid');
  });

  it('sends both auth headers on every query', async () => {
    const responder = taddy(() => ({ search: { searchId: 'hdr', podcastSeries: [] } }));
    await callTool(server, 'search_podcasts', { term: 'header-probe' }, responder);
    const { init } = responder.calls.at(-1);
    expect(init.method).toBe('POST');
    expect(init.headers.get('X-USER-ID')).toBe('7');
    expect(init.headers.get('X-API-KEY')).toBe('test-key');
  });

  it('fails clearly when a secret is unset, without calling the API', async () => {
    const responder = taddy(
      () => {
        throw new Error('must not reach the API without credentials');
      },
      { secrets: { TADDY_USER_ID: '7', TADDY_API_KEY: '' } },
    );
    const result = await callTool(server, 'search_podcasts', { term: 'no-secret' }, responder);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TADDY_API_KEY');
  });
});

describe('argument validation', () => {
  it('rejects a malformed uuid before making a request', async () => {
    const result = await callTool(server, 'get_transcript', { episode_uuid: '123' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('rejects a malformed date', async () => {
    const result = await callTool(server, 'search_podcasts', {
      term: 'x',
      published_after: 'last Tuesday',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_PARAMS');
  });
});

describe('value formatting', () => {
  it('converts epoch seconds to ISO dates, treating 0 as unknown', () => {
    expect(isoDate(1_719_792_000)).toBe('2024-07-01');
    expect(isoDate(0)).toBeNull();
    expect(isoDate(NULL)).toBeNull();
  });

  it('renders durations and timecodes readably', () => {
    expect(humanDuration(4980)).toBe('1h 23m');
    expect(humanDuration(545)).toBe('9m 05s');
    expect(humanDuration(0)).toBeNull();
    expect(timecode(3_723_000)).toBe('1:02:03');
    expect(timecode(4000)).toBe('0:04');
  });

  it('formats genres as a two-level path', () => {
    expect(formatGenre('PODCASTSERIES_ARTS_BOOKS')).toBe('Arts › Books');
    expect(formatGenre('PODCASTSERIES_HEALTH_AND_FITNESS_MENTAL_HEALTH')).toBe(
      'Health & Fitness › Mental Health',
    );
    expect(formatGenre('PODCASTSERIES_TRUE_CRIME')).toBe('True Crime');
  });

  it('resolves vocabulary values through aliases and partial names', () => {
    expect(resolveGenre('true crime')).toBe('PODCASTSERIES_TRUE_CRIME');
    expect(resolveGenre('Business > Investing')).toBe('PODCASTSERIES_BUSINESS_INVESTING');
    expect(resolveCountry('uk')).toBe('UNITED_KINGDOM');
    expect(resolveCountry('South Korea')).toBe('KOREA_SOUTH');
    // Taddy spells Dutch `DUTCH_FLEMISH`; a unique partial name resolves.
    expect(resolveLanguage('Dutch')).toBe('DUTCH_FLEMISH');
  });

  it('refuses to guess when a leading name covers two values', () => {
    // KOREA_NORTH and KOREA_SOUTH are different countries; picking one would be
    // a silent guess about which the caller meant.
    expect(() => resolveCountry('Korea')).toThrow(/more than one/);
    expect(() => resolveCountry('Korea')).toThrow(/KOREA_NORTH, KOREA_SOUTH/);
  });

  it('refuses a trailing fragment rather than resolving it to something unrelated', () => {
    // These all used to resolve: "Dutch" is not a country, "Africa" is not
    // SOUTH_AFRICA, and "fantasy" is not fantasy sports.
    expect(() => resolveCountry('Dutch')).toThrow(/not a Taddy country/);
    expect(() => resolveCountry('Africa')).toThrow(/not a Taddy country/);
    expect(() => resolveGenre('fantasy')).toThrow(/not a Taddy genre/);
    // …but the suggestion still names what the caller probably meant.
    expect(() => resolveCountry('Africa')).toThrow(/SOUTH_AFRICA/);
  });
});

describe('get_popular_podcasts', () => {
  it("returns Taddy's own ranking, filtered by genre and language", async () => {
    const responder = taddy(() => ({
      getPopularContent: { popularityRankId: 'p1', podcastSeries: [SERIES] },
    }));
    const result = await callTool(
      server,
      'get_popular_podcasts',
      { genres: ['technology'], language: 'English', limit: 5 },
      responder,
    );
    expect(result.ok).toBe(true);
    const { variables } = responder.calls.at(-1);
    expect(variables.taddyType).toBe('PODCASTSERIES');
    expect(variables.filterByGenres).toEqual(['PODCASTSERIES_TECHNOLOGY']);
    expect(variables.filterByLanguage).toBe('ENGLISH');
    expect(result.result.structured.count).toBe(1);
    expect(result.result.text).toContain('1 popular podcast(s)');
  });

  it('reports an empty ranking without inventing results', async () => {
    const result = await callTool(
      server,
      'get_popular_podcasts',
      { genres: ['cricket'] },
      taddy(() => ({ getPopularContent: { popularityRankId: 'p2', podcastSeries: [] } })),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.count).toBe(0);
    expect(result.result.text).toContain('No popular podcasts');
  });
});

describe('transcript guidance', () => {
  /** A show Taddy does not auto-transcribe, whose episode has no transcript. */
  const QUIET_SERIES = { ...SERIES, taddyTranscribeStatus: 'NOT_TRANSCRIBING' };

  it('spells out what a non-transcribed show means for the next call', async () => {
    const result = await callTool(
      server,
      'get_podcast',
      { rss_url: 'https://example.com/quiet.xml' },
      taddy(() => ({ getPodcastSeries: { ...QUIET_SERIES, episodes: [] } })),
    );
    expect(result.ok).toBe(true);
    expect(result.result.text).toContain('not auto-transcribed');
    expect(result.result.text).toContain('spends a credit');
  });

  it('explains each episode transcribe status in plain terms', async () => {
    const processing = await callTool(
      server,
      'get_episode',
      { uuid: '55555555-5555-4555-8555-555555555555' },
      taddy(() => ({
        getPodcastEpisode: { ...EPISODE, taddyTranscribeStatus: 'PROCESSING' },
      })),
    );
    expect(processing.result.text).toContain('queued at Taddy');

    const none = await callTool(
      server,
      'get_episode',
      { uuid: '66666666-6666-4666-8666-666666666666' },
      taddy(() => ({
        getPodcastEpisode: { ...EPISODE, taddyTranscribeStatus: 'NOT_TRANSCRIBING' },
      })),
    );
    expect(none.result.text).toContain('allow_on_demand: true');
  });
});

describe('lookup failures name the identifier that missed', () => {
  it('reports an unknown RSS url', async () => {
    const result = await callTool(
      server,
      'get_podcast',
      { rss_url: 'https://example.com/nope.xml' },
      taddy(() => ({ getPodcastSeries: NULL })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nope.xml');
  });

  it('reports an unknown iTunes id', async () => {
    const result = await callTool(
      server,
      'get_podcast',
      { itunes_id: 999 },
      taddy(() => ({ getPodcastSeries: NULL })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('999');
  });

  it('reports an unknown uuid', async () => {
    const result = await callTool(
      server,
      'get_podcast',
      { uuid: '77777777-7777-4777-8777-777777777777' },
      taddy(() => ({ getPodcastSeries: NULL })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('77777777-7777-4777-8777-777777777777');
  });

  it('reports a missing episode', async () => {
    const result = await callTool(
      server,
      'get_episode',
      { uuid: '88888888-8888-4888-8888-888888888888' },
      taddy(() => ({ getPodcastEpisode: NULL })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No episode');
  });
});

describe('transport-level failures', () => {
  it('treats a malformed body as retryable rather than as no results', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'malformed-probe' },
      (url, init) => {
        if (url.includes('/internal/secret')) {
          return { json: { value: SECRETS[JSON.parse(init?.body ?? '{}').name] ?? '' } };
        }
        return { text: 'not json at all' };
      },
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('malformed');
  });

  it('treats data of the wrong shape as retryable, not as an empty result', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'wrong-shape-probe' },
      taddy(() => ({ search: { podcastSeries: 'this should be an array' } })),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('unexpected shape');
  });

  it('maps a rejected argument to the upstream reason', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'bad-input-probe' },
      taddy(() => ({ errors: [{ code: 'BAD_USER_INPUT', message: 'page must be <= 20' }] })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('page must be <= 20');
  });

  it("reports a query Taddy considers too complex as our fault, not the caller's", async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'too-complex-probe' },
      taddy(() => ({ errors: [{ code: 'QUERY_TOO_COMPLEX', message: 'simplify' }] })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('QUERY_TOO_COMPLEX');
  });

  it('falls back to the upstream message for an unrecognised code', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'unknown-code-probe' },
      taddy(() => ({ errors: [{ code: 'SOMETHING_NEW', message: 'brand new failure' }] })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('brand new failure');
  });
});

describe('regressions from the multi-agent review', () => {
  it('does not cache an error envelope — a retryable error can actually be retried', async () => {
    // Taddy answers every failure with HTTP 200, so a status-only cache would
    // pin the failure and serve it back for the full TTL, making the tool's own
    // "try again shortly" advice impossible to act on.
    let calls = 0;
    const responder = taddy(() => {
      calls++;
      return calls === 1
        ? { errors: [{ code: 'TADDY_SERVER_ERROR', message: 'oops' }] }
        : { search: { searchId: 'recovered', podcastSeries: [] } };
    });
    const first = await callTool(server, 'search_podcasts', { term: 'recovery-probe' }, responder);
    expect(first.ok).toBe(false);
    expect(first.retryable).toBe(true);

    const second = await callTool(server, 'search_podcasts', { term: 'recovery-probe' }, responder);
    expect(second.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('still caches a SUCCESSFUL response for the same caller', async () => {
    let calls = 0;
    const responder = taddy(() => {
      calls++;
      return { search: { searchId: 'cached', podcastSeries: [] } };
    });
    await callTool(server, 'search_podcasts', { term: 'cache-hit-probe' }, responder);
    await callTool(server, 'search_podcasts', { term: 'cache-hit-probe' }, responder);
    expect(calls).toBe(1);
  });

  it('never serves one user’s cached response to another', async () => {
    let calls = 0;
    const responder = taddy(() => {
      calls++;
      return { search: { searchId: `u${String(calls)}`, podcastSeries: [] } };
    });
    const query = { term: 'tenant-isolation-probe' };
    await callTool(server, 'search_podcasts', query, responder, [], 'user-a');
    await callTool(server, 'search_podcasts', query, responder, [], 'user-a');
    expect(calls).toBe(1); // same user: served from cache
    await callTool(server, 'search_podcasts', query, responder, [], 'user-b');
    expect(calls).toBe(2); // different user: must reach upstream
  });

  it('sends useOnDemandCreditsIfNeeded: true when the caller opts in', async () => {
    const responder = taddy(() => ({
      getEpisodeTranscript: [{ id: '1', text: 'Generated on demand.' }],
    }));
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: '99999999-9999-4999-8999-999999999999', allow_on_demand: true },
      responder,
    );
    expect(result.ok).toBe(true);
    // The `false` half is asserted elsewhere; without this, hardcoding the flag
    // to false would leave the whole suite green.
    expect(responder.calls.at(-1).variables.useOnDemandCreditsIfNeeded).toBe(true);
    expect(result.result.structured.usedOnDemandCredit).toBe(true);
  });

  it('resolves a genre to the head match, not an unrelated leaf', async () => {
    const responder = taddy(() => ({ search: { searchId: 'g', podcastSeries: [] } }));
    await callTool(server, 'search_podcasts', { term: 'ai', genres: ['tech'] }, responder);
    // "tech" must reach TECHNOLOGY, not NEWS_TECH.
    expect(responder.calls.at(-1).variables.genres).toEqual(['PODCASTSERIES_TECHNOLOGY']);
  });

  it('echoes the vocabulary values a search was actually sent with', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'echo-probe', genres: ['investing'], countries: ['US'] },
      taddy(() => ({ search: { searchId: 'e', podcastSeries: [] } })),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.filters.genres).toEqual(['PODCASTSERIES_BUSINESS_INVESTING']);
    // Visible in the text too — a rewritten filter that stays hidden is the bug.
    expect(result.result.text).toContain('PODCASTSERIES_BUSINESS_INVESTING');
    expect(result.result.text).toContain('UNITED_STATES_OF_AMERICA');
  });

  it('reads published_before as the END of the named day', async () => {
    const responder = taddy(() => ({ search: { searchId: 'd', podcastSeries: [] } }));
    await callTool(
      server,
      'search_podcasts',
      { term: 'date-probe', published_after: '2026-07-27', published_before: '2026-07-27' },
      responder,
    );
    const { variables } = responder.calls.at(-1);
    // A single-day window must actually contain that day.
    expect(variables.publishedAfter).toBe(Date.parse('2026-07-27T00:00:00Z') / 1000);
    expect(variables.publishedBefore).toBe(Date.parse('2026-07-27T23:59:59Z') / 1000);
    expect(variables.publishedBefore).toBeGreaterThan(variables.publishedAfter);
  });

  it('rejects an inverted range before spending a request', async () => {
    const duration = await callTool(server, 'search_episodes', {
      term: 'x',
      min_duration_seconds: 3600,
      max_duration_seconds: 60,
    });
    expect(duration.ok).toBe(false);
    expect(duration.error).toContain('Swap them');

    const dates = await callTool(server, 'search_podcasts', {
      term: 'x',
      published_after: '2026-07-27',
      published_before: '2026-01-01',
    });
    expect(dates.ok).toBe(false);
  });

  it('refuses a segment_offset past the end of the transcript', async () => {
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segment_offset: 500 },
      taddy(() => ({ getEpisodeTranscript: [{ id: '1', text: 'Only one segment.' }] })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('past the end');
  });

  it('accepts more than five genres, which Taddy’s own examples use', async () => {
    const responder = taddy(() => ({
      getPopularContent: { popularityRankId: 'p', podcastSeries: [] },
    }));
    const result = await callTool(
      server,
      'get_popular_podcasts',
      {
        genres: ['business', 'careers', 'entrepreneurship', 'investing', 'management', 'marketing'],
      },
      responder,
    );
    expect(result.ok).toBe(true);
    expect(responder.calls.at(-1).variables.filterByGenres).toHaveLength(6);
  });
});

describe('regressions found by the live smoke test', () => {
  it('asks for `id` inside responseDetails, which Taddy requires', async () => {
    // Live, Taddy answers a search without it with HTTP 400: "The type
    // SearchResponseDetails is required to return the property id." The document
    // is schema-VALID either way, so only a real call could catch this.
    const responder = taddy(() => ({ search: { searchId: 'r', podcastSeries: [] } }));
    await callTool(server, 'search_podcasts', { term: 'response-details-probe' }, responder);
    expect(responder.calls.at(-1).query).toContain('responseDetails { id');

    const episodes = taddy(() => ({ search: { searchId: 'r2', podcastEpisodes: [] } }));
    await callTool(server, 'search_episodes', { term: 'response-details-probe' }, episodes);
    expect(episodes.calls.at(-1).query).toContain('responseDetails { id');
  });

  it('surfaces the reason from a 400, instead of a generic "malformed"', async () => {
    const result = await callTool(
      server,
      'search_podcasts',
      { term: 'four-hundred-probe' },
      (url, init) => {
        if (url.includes('/internal/secret')) {
          return { json: { value: SECRETS[JSON.parse(init?.body ?? '{}').name] ?? '' } };
        }
        return {
          status: 400,
          json: {
            errors: [
              {
                code: 'INVALID_QUERY_OR_SYNTAX',
                message: 'Inside of responseDetails please add the property id to the query.',
              },
            ],
          },
        };
      },
    );
    expect(result.ok).toBe(false);
    // The upstream sentence is the only thing that says how to fix it.
    expect(result.error).toContain('please add the property id');
  });

  it('treats a plan restriction as permanent, though Taddy codes it as a server error', async () => {
    // Verified live on a Free account: Taddy returns TADDY_SERVER_ERROR for
    // "You need to be a Pro or Business Taddy API user...". Trusting the code
    // alone tells the caller to retry a refusal that will never change.
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      taddy(() => ({
        errors: [
          {
            code: 'TADDY_SERVER_ERROR',
            message:
              'You need to be a Pro or Business Taddy API user to access the transcript for this episode.',
          },
        ],
      })),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('Pro or Business');
  });

  it('still treats a genuine Taddy outage as retryable', async () => {
    const result = await callTool(
      server,
      'get_transcript',
      { episode_uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      taddy(() => ({
        errors: [{ code: 'TADDY_SERVER_ERROR', message: 'Something went wrong on our end.' }],
      })),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('renders a person’s role as a word, not as API vocabulary', async () => {
    const result = await callTool(
      server,
      'get_episode',
      { uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      taddy(() => ({
        getPodcastEpisode: {
          ...EPISODE,
          persons: [{ uuid: 'p', name: 'Justin Jackson', role: 'PODCASTSERIES_HOST' }],
        },
      })),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.episode.persons[0].role).toBe('host');
    expect(result.result.text).toContain('Justin Jackson (host)');
    expect(result.result.text).not.toContain('PODCASTSERIES_HOST');
  });

  it('formats content roles', () => {
    expect(formatRole('PODCASTSERIES_GUEST')).toBe('guest');
    expect(formatRole('PODCASTSERIES_ASSISTANT_EDITOR')).toBe('assistant editor');
  });
});
