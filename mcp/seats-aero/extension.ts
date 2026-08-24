import { defineToolkit } from '@ontrove/extend/toolkit';
import { exploreAvailability } from './tools/explore-availability.ts';
import { getTrips } from './tools/get-trips.ts';
import { listPrograms } from './tools/list-programs.ts';
import { liveSearch } from './tools/live-search.ts';
import { searchAwards } from './tools/search-awards.ts';

/**
 * Seats.aero — a hosted MCP server over the Seats.aero **partner API**, the
 * award-availability search behind seats.aero. Five read-only tools cover the
 * whole surface: the mileage-program catalogue, the cached search, the bulk
 * (Explore) browse, flight-level trips for one availability, and a real-time
 * live search.
 *
 * Auth is a single `Partner-Authorization` header carrying the user's own key,
 * redeemed per invocation via `ctx.requireSecret('SEATS_AERO_API_KEY')`. Pro
 * subscribers generate one on the API tab of https://seats.aero/settings; the
 * partner API is for non-commercial use unless Seats.aero has agreed otherwise
 * in writing. The only egress is seats.aero.
 *
 * **The budget shapes the design.** A Pro key gets 1,000 calls a day, shared
 * across every app using it, so nothing here auto-pages and nothing fans out:
 * one tool call is one API call. `list_programs` answers from a local table so
 * the model can learn the `source` slugs, cabin coverage and per-program
 * capability flags for free, and every paged result says how to fetch the next
 * page instead of fetching it speculatively.
 *
 * **Four upstream conventions are corrected rather than relayed**, each because
 * taking it at face value produces a confident, wrong answer:
 *
 * 1. `DepartsAt`/`ArrivesAt` end in `Z` but are **airport-local times** — the
 *    reference says so, and its own example only reconciles with the trip's
 *    reported duration if read that way. Times are rendered local and labelled.
 * 2. `*MileageCost` is a **string**, and `"0"` means "not priced", not "free".
 * 3. `*RemainingSeats: 0` on a cabin the API has just marked available means
 *    "not reported" — eight programs never publish seat counts, and three never
 *    publish taxes. The program table carries those flags so a gap is named.
 * 4. `count` has no documented meaning, so it is passed through and never
 *    presented as a total; `returned` + `hasMore` drive every summary.
 *
 * And two rejections that would otherwise arrive as an empty HTTP 200: an
 * unknown mileage-program slug, and a cabin no requested program supports.
 */
export default defineToolkit({
  id: 'seats-aero',
  name: 'Seats.aero Award Search',
  description:
    'Search airline award availability across 26 mileage programs via the Seats.aero partner API: cached search by airport and date, per-program Explore, flight-level trips with miles and taxes, and real-time live search. Requires a SEATS_AERO_API_KEY secret — a Seats.aero Pro subscription, key generated on the API tab of seats.aero/settings (1,000 calls/day, non-commercial use). Read-only.',
  icon: '✈️',
  version: '1.0.0',
  secrets: ['SEATS_AERO_API_KEY'],
  scopes: [],
  visibility: 'shared',
  config: {
    home_airports: {
      label: 'Home airports',
      type: 'text[]',
      pattern: '^[A-Z]{3}$',
      hint: 'Three-letter IATA airport codes, e.g. YVR. Airports, not cities.',
    },
  },
  egress: ['seats.aero'],
  tools: [listPrograms, searchAwards, exploreAvailability, getTrips, liveSearch],
});
