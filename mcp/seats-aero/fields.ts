import { z } from '@ontrove/mcp';
import { CABINS, REGIONS } from './programs.ts';

/**
 * Zod fragments shared across the tools — the paging surface and the two
 * enumerations, declared once so every tool describes them identically.
 */

/**
 * Seats.aero's paging trio.
 *
 * The reference says `take` "must be >= 10 and <= 1000"; **neither bound is
 * enforced** — `take=3` returns three records and `take=1001` returns 1001, both
 * HTTP 200. So the floor is not reproduced here: refusing `take=3` would be this
 * tool inventing a rejection the API does not make. The ceiling is kept as a
 * response-size guard of our own, and described as such rather than as the
 * API's rule.
 *
 * `skip`/`cursor` are the documented paging mechanism, and they do not work as
 * documented: paging a provably static result set as 10 + 10 recovered 10 of the
 * 20 a single `take=20` returned, repeated 3, and produced 7 the baseline never
 * held — with the cursor carried exactly as instructed, and worse under
 * `order_by`. So the ceiling is the useful control here and paging is the
 * fallback, which is what both descriptions say.
 */
export const pageInput = {
  take: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe(
      'Results per page, 1–1000. THE PRIMARY SIZE CONTROL: a bigger page costs the same single API call, and raising it is the reliable way to see more — paging with skip measurably omits results.',
    ),
  skip: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Results already retrieved for this search; pair with cursor. Lossy — Seats.aero sorts the fetched page rather than the whole match set, so pages both repeat and omit records. Raise take instead when you need completeness.',
    ),
  cursor: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe(
      'Opaque cursor from the first page of this search, echoed back verbatim. Intended to stabilise ordering across pages; measured not to — carry it anyway when paging, but do not rely on it for completeness.',
    ),
};

/** The daily budget, as the API reports it on every response. */
export const quotaOutput = z
  .object({
    limit: z.number().optional(),
    remaining: z.number().optional(),
    resetsIn: z.number().optional().describe('Seconds until the daily window resets.'),
  })
  .optional()
  .describe('Calls left on this key today, read from the response headers.');

/** The structured `page` block every paged tool returns. */
export const pageOutput = z.object({
  returned: z.number(),
  hasMore: z.boolean(),
  cursor: z.union([z.number(), z.string()]).optional(),
  nextSkip: z.number().optional(),
  moreUrl: z.string().optional().describe("The API's own next-page path, when it sends one."),
  reportedCount: z
    .number()
    .optional()
    .describe("Seats.aero's count field. Observed to equal the page size — not a total."),
});

export const cabinEnum = z.enum(CABINS);
export const regionEnum = z.enum(REGIONS);

/** The cheapest itinerary of one routing shape, in one cabin. */
export const offerOutput = z.object({
  mileageCost: z.number().optional(),
  remainingSeats: z.number().optional().describe('Absent when the program did not report seats.'),
  airlines: z.array(z.string()),
  taxes: z
    .object({ amount: z.number(), currency: z.string().optional(), symbol: z.string().optional() })
    .optional()
    .describe('Converted from the API minor units: 560 → 5.60.'),
});

/** Co-brand credit-card pricing for one cabin. */
export const cardRateOutput = z.object({
  card: z.string(),
  mileageCost: z.number().optional(),
  nonStopMileageCost: z.number().optional(),
  unlockedAirlines: z.array(z.string()),
});

/**
 * One cabin's award space. `best` and `nonStop` are genuinely different prices —
 * the cheapest routing is often a connection — so they are never conflated.
 */
export const cabinOfferOutput = z.object({
  cabin: cabinEnum,
  best: offerOutput.optional().describe('Cheapest itinerary of any routing.'),
  nonStop: offerOutput.optional().describe('Cheapest non-stop. Frequently dearer than best.'),
  bestIsNonStop: z.boolean().describe('True when the cheapest routing needs no connection.'),
  dynamic: z
    .object({ best: offerOutput.optional(), nonStop: offerOutput.optional() })
    .optional()
    .describe('The same before the dynamic-pricing filter; only set with include_filtered.'),
  cardRates: z.array(cardRateOutput),
  seatsPublished: z
    .boolean()
    .describe('False when this program never publishes seat counts, so an absent count is normal.'),
});

/** A flight leg. Times are the airport's own local clock, never UTC. */
export const segmentOutput = z.object({
  flightNumber: z.string().optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  departsLocal: z.string().optional(),
  arrivesLocal: z.string().optional(),
  aircraft: z.string().optional(),
  fareClass: z.string().optional(),
  distance: z.number().optional(),
  durationMinutes: z.number().optional(),
});

/** One bookable itinerary in one cabin. */
export const tripOutput = z.object({
  id: z.string().optional(),
  availabilityId: z.string().optional(),
  source: z.string().optional(),
  program: z.string(),
  cabin: z.string().optional(),
  mileageCost: z.number().optional(),
  taxes: z
    .object({ amount: z.number(), currency: z.string().optional(), symbol: z.string().optional() })
    .optional(),
  remainingSeats: z.number().optional(),
  seatsPublished: z.boolean(),
  stops: z.number().optional(),
  durationMinutes: z.number().optional(),
  duration: z.string().optional(),
  carriers: z.array(z.string()),
  flightNumbers: z.array(z.string()),
  connections: z.array(z.string()),
  aircraft: z.array(z.string()),
  fareClasses: z.array(z.string()),
  origin: z.string().optional(),
  destination: z.string().optional(),
  departsLocal: z.string().optional().describe('Airport-local clock time, never UTC.'),
  arrivesLocal: z.string().optional().describe('Airport-local clock time, never UTC.'),
  distance: z.number().optional(),
  cardRates: z.array(
    z.object({
      card: z.string(),
      mileageCost: z.number().optional(),
      filtered: z.boolean(),
    }),
  ),
  filtered: z.boolean().optional(),
  segments: z.array(segmentOutput),
});

/** A route + date + program summary. */
export const availabilityOutput = z.object({
  id: z.string().optional(),
  source: z.string().optional(),
  program: z.string(),
  date: z.string().optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  originRegion: z.string().optional(),
  destinationRegion: z.string().optional(),
  distance: z.number().optional(),
  updatedAt: z.string().optional(),
  cabins: z.array(cabinOfferOutput),
  trips: z.array(tripOutput).optional(),
});

/** A deep link into a program's own booking flow. */
export const bookingLinkOutput = z.object({
  label: z.string().optional(),
  url: z.string().optional(),
  primary: z.boolean(),
});

/** `include_filtered`, worded the same way wherever it appears. */
export const includeFiltered = z
  .boolean()
  .default(false)
  .describe(
    'Include award space that exists only at dynamic pricing, which Seats.aero filters out by default. Those results come back under a `dynamic` block on the cabin, priced separately — they are usually far more expensive (a filtered-out premium-economy seat on the same route was 135,900 miles).',
  );
