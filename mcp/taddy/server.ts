import { defineToolkit } from '@ontrove/extend/toolkit';
import { checkQuotaTool } from './tools/check-quota.ts';
import { getEpisodeTool } from './tools/get-episode.ts';
import { getLatestEpisodesTool } from './tools/get-latest-episodes.ts';
import { getPodcastTool } from './tools/get-podcast.ts';
import { getPopularPodcastsTool } from './tools/get-popular-podcasts.ts';
import { getTopChartsTool } from './tools/get-top-charts.ts';
import { getTranscriptTool } from './tools/get-transcript.ts';
import { searchEpisodesTool } from './tools/search-episodes.ts';
import { searchPodcastsTool } from './tools/search-podcasts.ts';

/**
 * Taddy — a hosted MCP server over Taddy's GraphQL Podcast API
 * (`https://api.taddy.org`), a directory of 4M+ podcasts and 200M+ episodes.
 *
 * Nine read-only tools, each in its own module under `tools/`, over the shared
 * GraphQL plumbing in `client.ts`, the query documents in `queries.ts`, the
 * wire→output mapping in `shapes.ts`, and the vocabulary lookup in `enums.ts`:
 *
 *  - `search_podcasts` / `search_episodes` — keyword search, split by type,
 *  - `get_podcast` / `get_episode` — single-object lookups,
 *  - `get_transcript` — transcripts with speakers and timecodes,
 *  - `get_latest_episodes` — newest episodes across up to 1000 shows,
 *  - `get_top_charts` / `get_popular_podcasts` — Apple's chart and Taddy's own,
 *  - `check_quota` — the account's remaining balances.
 *
 * **Auth.** Two per-tenant secrets, `TADDY_USER_ID` and `TADDY_API_KEY`, from a
 * free developer account at taddy.org/signup/developers, sent as the `X-USER-ID`
 * and `X-API-KEY` headers. Set them with
 * `trove secret set taddy TADDY_USER_ID …`.
 *
 * **Quota shapes this design.** Taddy meters by the MONTH — 500 requests on the
 * free tier — so a wasted call is not a slow call, it is a call the user does
 * not get back. Hence: `get_podcast` returns the show AND a page of its episodes
 * in one request (GraphQL makes that free, where a REST client would spend two);
 * every argument that can be checked locally is checked before egress; responses
 * are cached per user in-isolate; and `check_quota` exists so the balance can be
 * read rather than guessed at.
 *
 * **Two searches, not one.** Taddy exposes a single `search` field for both
 * shows and episodes, but its filters are not interchangeable — a duration
 * filter on a series search returns an empty array rather than an error. One
 * merged tool would therefore advertise arguments that silently match nothing,
 * so each type gets the arguments that actually work on it.
 *
 * **Transcripts can spend money, so they ask first.** Taddy's
 * `useOnDemandCreditsIfNeeded` defaults to `true`, generating (and charging for)
 * a missing transcript. `get_transcript` inverts that to opt-in. The flag buys
 * control over COMMISSIONING a transcript, not over paying for one: only
 * podcast-published transcripts are free, and a Taddy-generated one costs a
 * credit even when it already exists. Since `taddyTranscribeStatus` reports both
 * as `COMPLETED`, every surface that shows the status says so — see
 * `transcript.ts`.
 *
 * Nothing here writes to the knowledge base — no `trove:ingest` scope, no save
 * tool.
 */
export default defineToolkit({
  egress: ['api.taddy.org'],
  tools: [
    searchPodcastsTool,
    searchEpisodesTool,
    getPodcastTool,
    getEpisodeTool,
    getTranscriptTool,
    getLatestEpisodesTool,
    getTopChartsTool,
    getPopularPodcastsTool,
    checkQuotaTool,
  ],
});
