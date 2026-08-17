import { ToolError, tool, z } from '@ontrove/mcp';
import { apiKey, quotaNote, seatsJson } from '../client.ts';
import { bookingLinkOutput, quotaOutput, tripOutput } from '../fields.ts';
import { bookingLinkLines, type Trip, toBookingLinks, toTrip, tripLines } from '../trips.ts';
import { WireTripsResponse } from '../wire.ts';

/**
 * `get_trips` — flight-level detail behind one availability summary
 * (`GET /trips/{id}`), plus the program's own booking deep links.
 *
 * An availability says "business class SFO→LHR on the 11th for 65,000 miles";
 * this says *which flights*, in what order, on what aircraft, and what the taxes
 * come to. Times come back as airport-local clock times, never UTC instants.
 */

/** Trips spelled out in the prose mirror; the rest ride in `structured`. */
const TEXT_LIMIT = 25;

/**
 * Choose which trips the prose spells out: the cheapest in **each cabin** first,
 * then the next cheapest overall until the cap.
 *
 * Cheapest-first alone hides the very thing `include_filtered` is for. One live
 * availability returns 59 trips without the flag and **178 with it** — the extra
 * 119 include the only 11 premium-cabin trips there are, priced far above the
 * economy awards. Ranked purely by price, all 25 prose slots go to economy and
 * the flag appears to have done nothing. Guaranteeing one line per cabin makes a
 * newly revealed cabin visible for the price of at most three slots.
 *
 * @param sorted - Trips already ordered cheapest-first.
 * @param limit - How many to spell out.
 */
export function summarise(sorted: readonly Trip[], limit: number): Trip[] {
  const cheapestPerCabin: Trip[] = [];
  const seen = new Set<string>();
  for (const trip of sorted) {
    const cabin = trip.cabin ?? 'unknown';
    if (seen.has(cabin)) continue;
    seen.add(cabin);
    cheapestPerCabin.push(trip);
  }
  const picked = new Set(cheapestPerCabin);
  const rest = sorted.filter((trip) => !picked.has(trip));
  // Keep the overall cheapest-first reading by re-sorting the chosen subset.
  return [...cheapestPerCabin, ...rest]
    .slice(0, Math.max(limit, cheapestPerCabin.length))
    .sort(
      (a, b) =>
        (a.mileageCost ?? Number.MAX_SAFE_INTEGER) - (b.mileageCost ?? Number.MAX_SAFE_INTEGER),
    );
}

export const getTrips = tool({
  name: 'get_trips',
  title: 'Seats.aero: Get flights for an availability',
  description:
    'Expand one availability summary into the actual bookable itineraries: flight numbers, ' +
    'aircraft, connection times, miles, taxes and seats per cabin, plus deep links into the ' +
    "program's booking flow. Takes the availability id from search_awards or " +
    "explore_availability. All departure/arrival times are the airport's own local clock.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    availability_id: z
      .string()
      .min(1)
      .describe('The availability id from a search_awards or explore_availability result.'),
    include_filtered: z
      .boolean()
      .default(false)
      .describe(
        'Include dynamically-priced itineraries Seats.aero filters out by default. It matters far more here than on a search: one live availability returned 59 trips without it and 178 with, including the only premium-cabin options it had. Turn it on when a cabin the summary showed as dynamic-only is the one you want.',
      ),
    cabin: z
      .enum(['economy', 'premium', 'business', 'first'])
      .optional()
      .describe('Only return trips in this cabin. Filtered here, not upstream.'),
  }),
  output: z.object({
    availabilityId: z.string(),
    count: z.number(),
    quota: quotaOutput,
    trips: z.array(tripOutput),
    bookingLinks: z.array(bookingLinkOutput),
  }),
  async handler(args, ctx) {
    const id = args.availability_id.trim();
    if (!/^[\w-]+$/.test(id)) {
      throw new ToolError(
        `availability_id "${args.availability_id}" is not a Seats.aero id. Take it from the id field of a search_awards or explore_availability result.`,
        { retryable: false },
      );
    }
    const key = await apiKey(ctx);
    ctx.log('get_trips', { availabilityId: id });

    const query = args.include_filtered ? '?include_filtered=true' : '';
    const { body, quota } = await seatsJson(
      {
        path: `/trips/${encodeURIComponent(id)}${query}`,
        what: `get trips for availability ${id}`,
      },
      ctx,
      key,
      WireTripsResponse,
    );

    const all = (body?.data ?? []).map((trip) => toTrip(trip));
    const trips = args.cabin ? all.filter((t) => t.cabin === args.cabin) : all;
    const links = toBookingLinks(body?.booking_links);

    // An availability that exists but yields no trips is normal for the programs
    // that publish no flight-level data — say which case this is.
    const empty =
      all.length === 0
        ? `Seats.aero returned no flight-level trips for availability ${id}. That happens when the program does not publish trip data, or when the cached availability has since been re-priced.`
        : `No ${args.cabin} trips among the ${all.length} returned for availability ${id}.`;

    const sorted = [...trips].sort(
      (a, b) =>
        (a.mileageCost ?? Number.MAX_SAFE_INTEGER) - (b.mileageCost ?? Number.MAX_SAFE_INTEGER),
    );
    const shown = summarise(sorted, TEXT_LIMIT);
    const clipped =
      sorted.length > shown.length
        ? [
            '',
            `… ${sorted.length - shown.length} further trip(s) omitted from this summary — every one is in the structured result. Narrow with cabin= to see more of them here.`,
          ]
        : [];

    return {
      text: trips.length
        ? [
            `${trips.length} trip(s) for availability ${id}${
              args.cabin ? ` in ${args.cabin}` : ''
            }, cheapest first (one per cabin guaranteed):`,
            '',
            ...shown.flatMap((trip) => tripLines(trip)),
            ...clipped,
            ...bookingLinkLines(links),
            ...quotaNote(quota).map((line) => `\n${line}`),
          ].join('\n')
        : empty,
      structured: {
        availabilityId: id,
        count: trips.length,
        quota,
        trips: sorted,
        bookingLinks: links,
      },
    };
  },
});
