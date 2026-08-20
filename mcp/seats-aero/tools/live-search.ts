import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { apiKey, isAccessToken, quotaNote, seatsJson } from '../client.ts';
import { bookingLinkOutput, quotaOutput, tripOutput } from '../fields.ts';
import { airportList, isoDate } from '../params.ts';
import { programName, resolveSources } from '../programs.ts';
import { bookingLinkLines, toBookingLinks, toTrip, tripLines } from '../trips.ts';
import { WireLiveResponse } from '../wire.ts';

/**
 * `live_search` — a real-time query straight at one mileage program
 * (`POST /live`), bypassing the cache.
 *
 * **Gated behind a commercial agreement.** The reference presents live search as
 * part of the partner API, but a Pro key is refused with
 * `401 {"error":"Your API key is not enabled for the live search API. Live
 * search requires a commercial agreement with seats.aero."}` — verified against
 * a live Pro key. So for the users this toolkit is built for, this tool cannot
 * work, and that is stated in its description rather than discovered as a
 * mystery 401. `client.ts` maps the refusal to an entitlement message instead of
 * "check your API key", which would send someone to replace a working one.
 *
 * Expensive in every other sense too: it is slow, it is one route on one date on
 * one program, and it spends from the same 1,000-a-day budget as a search
 * covering a whole month across every program. Its results are also **not**
 * persisted — the ids it returns are not availability ids and `get_trips` cannot
 * expand them.
 */
export const liveSearch = tool({
  name: 'live_search',
  title: 'Seats.aero: Live search one route',
  description:
    'Query one mileage program in real time for one route on one date, bypassing the cache. ' +
    'REQUIRES A COMMERCIAL AGREEMENT with Seats.aero — a Pro subscription does NOT include ' +
    'live search, and a Pro key is refused here even though it works on every other tool. ' +
    'Prefer search_awards, which covers the same routes from the cache. Use this only when ' +
    'the account is known to be commercially licensed and you need this second’s inventory. ' +
    'Results are not stored by Seats.aero, so their ids cannot be passed to get_trips.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    origin_airport: z.string().describe('Origin IATA airport code, e.g. SFO.'),
    destination_airport: z.string().describe('Destination IATA airport code, e.g. LHR.'),
    departure_date: z.string().describe('Departure date, YYYY-MM-DD.'),
    source: z.string().describe('The mileage program slug to query, e.g. aeroplan.'),
    seat_count: z
      .number()
      .int()
      .min(1)
      .max(9)
      .default(1)
      .describe('Number of adult passengers, 1–9. Award space is per-passenger.'),
    show_dynamic_pricing: z
      .boolean()
      .default(false)
      .describe('Keep dynamically-priced fares, which are filtered out by default.'),
    disable_filters: z
      .boolean()
      .default(false)
      .describe('Disable every filter, including the mismatched-airport one. Noisier results.'),
  }),
  output: z.object({
    source: z.string(),
    program: z.string(),
    route: z.string(),
    departureDate: z.string(),
    count: z.number(),
    quota: quotaOutput,
    trips: z.array(tripOutput),
    bookingLinks: z.array(bookingLinkOutput),
  }),
  async handler(args, ctx) {
    const origin = airportList([args.origin_airport], 'origin_airport');
    const destination = airportList([args.destination_airport], 'destination_airport');
    if (origin.includes(',') || destination.includes(',')) {
      throw new ToolError(
        'live_search takes exactly one origin and one destination. Use search_awards to cover several airports at once.',
        { retryable: false },
      );
    }
    const date = isoDate(args.departure_date, 'departure_date');
    const [source] = resolveSources([args.source], 'source');
    if (source === undefined) {
      throw new ToolError('source: give one mileage program slug, e.g. aeroplan.', {
        retryable: false,
      });
    }

    const key = await apiKey(ctx);
    // Documented upstream limitation: OAuth access tokens reach every partner
    // endpoint *except* this one, and the refusal arrives as a bare 401 that
    // reads like a bad key. Name it instead.
    if (isAccessToken(key)) {
      throw new ToolError(
        'live_search cannot be used with a Seats.aero OAuth2 access token — the partner API allows those on every endpoint except live search. Set SEATS_AERO_API_KEY to a personal Pro API key (seats.aero → Settings → API) to use this tool; the other tools work with either.',
        { retryable: false },
      );
    }
    ctx.log('live_search', { source, origin, destination, date });

    const { body, quota } = await seatsJson(
      {
        path: '/live',
        what: `live-search ${origin}→${destination} on ${source}`,
        method: 'POST',
        body: {
          origin_airport: origin,
          destination_airport: destination,
          departure_date: date,
          source,
          seat_count: args.seat_count,
          show_dynamic_pricing: args.show_dynamic_pricing,
          disable_filters: args.disable_filters,
        },
      },
      ctx,
      key,
      WireLiveResponse,
    );

    // The endpoint can answer a failure inside an HTTP 200; an empty success and
    // a failed search are not the same thing.
    if (body?.success === false) {
      throw new ToolError(
        `Seats.aero could not live-search ${origin}→${destination} on ${source}: ${
          body.error ?? 'no reason given'
        }`,
        { retryable: false },
      );
    }

    const trips = (body?.results ?? []).map((trip) => toTrip(trip));
    const links = toBookingLinks(body?.bookingLinks);
    const heading = `${programName(source)} live search — ${origin}→${destination} on ${date}, ${args.seat_count} passenger(s)`;

    return {
      text: trips.length
        ? [
            heading,
            '',
            ...trips.flatMap((trip) => tripLines(trip)),
            ...bookingLinkLines(links),
            ...quotaNote(quota).map((line) => `\n${line}`),
          ].join('\n')
        : `${heading}\n\nNo award space found. This is a live answer from ${programName(source)}, not a cache miss.`,
      structured: {
        quota,
        source,
        program: programName(source),
        route: `${origin}-${destination}`,
        departureDate: date,
        count: trips.length,
        trips,
        bookingLinks: links,
      },
    };
  },
});
