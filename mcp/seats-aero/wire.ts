import { z } from '@ontrove/mcp';

/**
 * The Seats.aero partner API's own JSON shapes, as **lenient parse schemas**.
 *
 * Every field is `nullish()` or defaulted, so a shape drift degrades one field
 * rather than failing the whole call — these describe the upstream, not this
 * tool's output contract. `ctx.fetchJson` validates against them, which is what
 * makes the decoders in `render.ts`/`trips.ts` safe without hand-written guards.
 *
 * Where the reference commits to one JSON type but the API is observably
 * inconsistent, the schema accepts both rather than rejecting the response:
 * mileage costs arrive as **strings** on availabilities and **numbers** on
 * trips, and the `cursor` is documented as an opaque token that merely "is
 * currently a Unix timestamp".
 *
 * Two of these shapes are actively misleading if taken at face value, which is
 * why nothing outside `render.ts`/`trips.ts` reads them directly:
 *
 * - `*MileageCost` `"0"` means "not available", not "free".
 * - `DepartsAt`/`ArrivesAt` carry a `Z` suffix but are **airport-local times**,
 *   not UTC (the reference says so, and the arithmetic agrees: its own example
 *   spans 26h53m of wall clock between a UTC-5 and a UTC+3 airport for a trip it
 *   reports as `TotalDuration: 1133` minutes = 18h53m).
 */

/** A number the API may serialise as a string (`"12500"`). */
const loose = z.union([z.number(), z.string()]).nullish();
const text = z.string().nullish();

/** The route an availability belongs to. */
export const WireRoute = z.object({
  ID: text,
  OriginAirport: text,
  OriginRegion: text,
  DestinationAirport: text,
  DestinationRegion: text,
  NumDaysOut: loose,
  Distance: loose,
  Source: text,
});

/**
 * One leg of a trip. Times are airport-local despite the `Z`.
 *
 * `Order` is the leg's position in the itinerary. It is discarded by the
 * decoder only after being used to sort — the array order is not authoritative,
 * and reading `segments[0]` for the origin would otherwise be a guess.
 */
export const WireSegment = z.object({
  ID: text,
  FlightNumber: text,
  Distance: loose,
  FareClass: text,
  AircraftName: text,
  AircraftCode: text,
  OriginAirport: text,
  DestinationAirport: text,
  DepartsAt: text,
  ArrivesAt: text,
  Source: text,
  Cabin: text,
  Duration: loose,
  /** Absent on live-search segments, which the reference does not give an order. */
  Order: loose,
});

/** One bookable itinerary in one cabin. */
export const WireTrip = z.object({
  ID: text,
  RouteID: text,
  AvailabilityID: text,
  AvailabilitySegments: z.array(WireSegment).nullish(),
  TotalDuration: loose,
  Stops: loose,
  Carriers: text,
  RemainingSeats: loose,
  MileageCost: loose,
  /** Taxes in minor units (cents): `1290` is 12.90. */
  TotalTaxes: loose,
  TaxesCurrency: text,
  TaxesCurrencySymbol: text,
  AllianceCost: loose,
  FlightNumbers: text,
  DepartsAt: text,
  ArrivesAt: text,
  Cabin: text,
  Source: text,
  OriginAirport: text,
  DestinationAirport: text,
  /** Connection airports in order; undocumented but sent (`["ORD"]`). */
  Connections: z.array(z.string()).nullish(),
  /** Full aircraft names per leg (`"Boeing 767-300"`), unlike the segment codes. */
  Aircraft: z.array(z.string()).nullish(),
  FareClasses: z.array(z.string()).nullish(),
  TotalSegmentDistance: loose,
  /** Co-brand card rates, `{ UACARD: { MileageCost, Filtered } }`. Undocumented. */
  OptionalPrices: z.unknown(),
  /** Live search only: the result was excluded by the dynamic-pricing filter. */
  Filtered: z.boolean().nullish(),
});

/**
 * A route + date + program summary.
 *
 * The cabin fields are keyed by a `Y`/`W`/`J`/`F` prefix rather than nested, so
 * the schema keeps unknown keys (`catchall`) and the decoder reads them by
 * prefix. That also means the **undocumented raw/dynamic-price fields**
 * `include_filtered` alludes to survive parsing if the API sends them.
 */
export const WireAvailability = z
  .object({
    ID: text,
    RouteID: text,
    Route: WireRoute.nullish(),
    Date: text,
    ParsedDate: text,
    Source: text,
    CreatedAt: text,
    UpdatedAt: text,
    AvailabilityTrips: z.array(WireTrip).nullish(),
    /** Availability-level currency for every `*TotalTaxes` figure on the record. */
    TaxesCurrency: text,
    /** Co-brand card rates, cabin-prefixed (`{ UACARD: { Y, YDirect, … } }`). */
    OptionalPricing: z.unknown(),
  })
  .catchall(z.unknown());

/** The `cursor` is documented as opaque — carried through, never interpreted. */
const cursor = z.union([z.number(), z.string()]).nullish();

/** `GET /search` and `GET /availability`. */
export const WireAvailabilityPage = z.object({
  data: z.array(WireAvailability).nullish(),
  /** Undocumented semantics — passed through, never interpreted as a total. */
  count: loose,
  hasMore: z.boolean().nullish(),
  /** The API's own next-page path. Undocumented but sent by both endpoints. */
  moreURL: text,
  cursor,
});

/** A deep link to the program's own booking flow. */
export const WireBookingLink = z.object({
  label: text,
  link: text,
  primary: z.boolean().nullish(),
});

/** `GET /trips/{id}`. Note the snake_case keys — live search uses camelCase. */
export const WireTripsResponse = z.object({
  data: z.array(WireTrip).nullish(),
  booking_links: z.array(WireBookingLink).nullish(),
  carriers: z.unknown(),
});

/** `POST /live`. */
export const WireLiveResponse = z.object({
  results: z.array(WireTrip).nullish(),
  bookingLinks: z.array(WireBookingLink).nullish(),
  success: z.boolean().nullish(),
  error: text,
});

export type WireRoute = z.infer<typeof WireRoute>;
export type WireSegment = z.infer<typeof WireSegment>;
export type WireTrip = z.infer<typeof WireTrip>;
export type WireAvailability = z.infer<typeof WireAvailability>;
export type WireAvailabilityPage = z.infer<typeof WireAvailabilityPage>;
export type WireBookingLink = z.infer<typeof WireBookingLink>;
export type WireTripsResponse = z.infer<typeof WireTripsResponse>;
export type WireLiveResponse = z.infer<typeof WireLiveResponse>;

/** A cursor as the API hands it back: opaque, echoed verbatim on the next page. */
export type Cursor = number | string;
