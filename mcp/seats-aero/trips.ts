import {
  csv,
  fmtDuration,
  hasPublishedSeats,
  miles,
  num,
  seatsText,
  str,
  type Taxes,
  taxesText,
  toTaxes,
} from './money.ts';
import { programName } from './programs.ts';
import type { WireBookingLink, WireSegment, WireTrip } from './wire.ts';

/**
 * Trips and segments, decoded.
 *
 * The headline correction is **time zones**. Seats.aero serialises `DepartsAt`
 * and `ArrivesAt` with a `Z` suffix, but they are *airport-local* times. The
 * reference says so, and live data settles it: UA2199/UA938 leaves SFO at 14:05
 * and reaches LHR at 11:55 the next day, which is 21h50m of wall clock read as
 * UTC — while the trip reports `TotalDuration: 830` minutes, 13h50m, exactly
 * right once both are read as local clocks. Anything parsing those strings as
 * instants would mis-state every departure it printed, so the `Z` is stripped
 * and the times are labelled local.
 */

/** One flight leg. Times are the airport's own local clock. */
export interface Segment {
  flightNumber?: string;
  origin?: string;
  destination?: string;
  /** Local departure at `origin`, `YYYY-MM-DD HH:MM`. */
  departsLocal?: string;
  /** Local arrival at `destination`, `YYYY-MM-DD HH:MM`. */
  arrivesLocal?: string;
  aircraft?: string;
  fareClass?: string;
  distance?: number;
  durationMinutes?: number;
}

/** Co-brand credit-card pricing for one trip. */
export interface TripCardRate {
  card: string;
  mileageCost?: number;
  /** True when Seats.aero's dynamic-pricing filter excludes this rate. */
  filtered: boolean;
}

/** One bookable itinerary in one cabin. */
export interface Trip {
  id?: string;
  availabilityId?: string;
  source?: string;
  program: string;
  cabin?: string;
  mileageCost?: number;
  taxes?: Taxes;
  remainingSeats?: number;
  /** False when this program never publishes seat counts. */
  seatsPublished: boolean;
  stops?: number;
  durationMinutes?: number;
  /** `13h 50m`. */
  duration?: string;
  carriers: string[];
  flightNumbers: string[];
  /** Connection airports, in order. */
  connections: string[];
  /** Full aircraft names, e.g. `Boeing 767-300`, one per leg. */
  aircraft: string[];
  fareClasses: string[];
  origin?: string;
  destination?: string;
  departsLocal?: string;
  arrivesLocal?: string;
  /** Total flown distance across every leg. */
  distance?: number;
  cardRates: TripCardRate[];
  /** Live search only: excluded by the dynamic-pricing filter. */
  filtered?: boolean;
  segments: Segment[];
}

/** A deep link into the program's own booking flow. */
export interface BookingLink {
  label?: string;
  url?: string;
  primary: boolean;
}

/**
 * Render one of the API's pseudo-UTC timestamps as the local clock time it
 * actually is: `2026-09-01T14:05:00Z` → `2026-09-01 14:05`. The `Z` is dropped
 * rather than honoured, because honouring it would shift the time.
 */
export function localTime(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2})/.exec(raw);
  return match ? `${match[1]} ${match[2]}` : raw;
}

/**
 * Put an itinerary's legs in flying order.
 *
 * Trip segments carry an explicit `Order`, and array position is not documented
 * to match it — so the first leg's origin and the last leg's destination (which
 * become the trip's endpoints) would otherwise be a guess. Live-search segments
 * have no `Order` at all, so their array index stands in; `sort` is stable, so
 * that leaves them exactly as they arrived.
 */
function orderSegments(segments: readonly WireSegment[]): WireSegment[] {
  return segments
    .map((segment, index) => ({ segment, order: num(segment.Order) ?? index }))
    .toSorted((a, b) => a.order - b.order)
    .map(({ segment }) => segment);
}

function toSegment(wire: WireSegment): Segment {
  return {
    flightNumber: str(wire.FlightNumber),
    origin: str(wire.OriginAirport),
    destination: str(wire.DestinationAirport),
    departsLocal: localTime(wire.DepartsAt),
    arrivesLocal: localTime(wire.ArrivesAt),
    aircraft: str(wire.AircraftName) ?? str(wire.AircraftCode),
    fareClass: str(wire.FareClass),
    distance: num(wire.Distance),
    durationMinutes: num(wire.Duration),
  };
}

/** Read `OptionalPrices` — the per-trip co-brand card rates. */
function cardRates(wire: WireTrip): TripCardRate[] {
  const pricing = wire.OptionalPrices;
  if (typeof pricing !== 'object' || pricing === null) return [];
  const rates: TripCardRate[] = [];
  for (const [card, value] of Object.entries(pricing as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const block = value as Record<string, unknown>;
    const cost = num(block.MileageCost);
    if (cost === undefined || cost === 0) continue;
    rates.push({ card, mileageCost: cost, filtered: block.Filtered === true });
  }
  return rates;
}

/** Use `derive()` when the API omitted the field (as `minify_trips` does). */
function orEmpty(value: string[], derive: () => string[]): string[] {
  return value.length > 0 ? value : derive();
}

/** Strings the API sends as arrays, defended against a scalar or a null. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return csv(value);
}

/**
 * What a trip embedded in an availability can borrow from its parent.
 *
 * `minify_trips` is not a light trim. A minified trip keeps exactly nine fields
 * — id, availability id, cabin, carriers, miles, seats, stops, duration and
 * taxes — and drops everything else, **including `AvailabilitySegments`,
 * `Source` and `TaxesCurrency`**. The last two are what make the rest
 * intelligible: without them a minified trip decodes to "unknown program" with
 * an unlabelled currency, which is a price nobody can act on. Both sit on the
 * availability carrying the trip, so they are inherited rather than lost.
 */
export interface TripContext {
  source?: string;
  taxesCurrency?: string;
  taxesSymbol?: string;
}

/** Sum a per-leg figure, or `undefined` when no leg reported one. */
function total(values: (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : undefined;
}

/**
 * Map one wire trip into the tool's shape.
 *
 * Where the API omits a field that the **segments** can supply — flight numbers,
 * connection airports, endpoints, aircraft, fare classes, distance, the
 * departure and arrival instants — it is derived rather than left blank. That
 * covers live-search results, which carry segments but omit several of the
 * roll-ups. It cannot rescue `minify_trips`, which takes the segments away too;
 * there, inheriting the program and currency from the parent is what keeps the
 * remaining nine fields meaningful.
 */
export function toTrip(wire: WireTrip, context: TripContext = {}): Trip {
  const source = str(wire.Source) ?? context.source;
  const seats = num(wire.RemainingSeats);
  const segments = orderSegments(wire.AvailabilitySegments ?? []).map((segment) =>
    toSegment(segment),
  );
  const cost = num(wire.MileageCost);
  const legs = segments.length;

  return {
    id: str(wire.ID),
    availabilityId: str(wire.AvailabilityID),
    source,
    program: programName(source),
    cabin: str(wire.Cabin),
    mileageCost: cost === 0 ? undefined : cost,
    taxes: toTaxes(
      wire.TotalTaxes,
      wire.TaxesCurrency ?? context.taxesCurrency,
      wire.TaxesCurrencySymbol ?? context.taxesSymbol,
      source,
    ),
    remainingSeats: seats !== undefined && seats > 0 ? seats : undefined,
    seatsPublished: hasPublishedSeats(source),
    stops: num(wire.Stops) ?? (legs > 0 ? legs - 1 : undefined),
    durationMinutes: num(wire.TotalDuration),
    duration: fmtDuration(num(wire.TotalDuration)),
    carriers: [...new Set(csv(wire.Carriers))],
    flightNumbers: orEmpty(csv(wire.FlightNumbers), () =>
      segments.map((leg) => leg.flightNumber).filter((value): value is string => Boolean(value)),
    ),
    connections: orEmpty(list(wire.Connections), () =>
      segments
        .slice(0, -1)
        .map((leg) => leg.destination)
        .filter((value): value is string => Boolean(value)),
    ),
    aircraft: orEmpty(list(wire.Aircraft), () =>
      segments.map((leg) => leg.aircraft).filter((value): value is string => Boolean(value)),
    ),
    fareClasses: orEmpty(list(wire.FareClasses), () =>
      segments.map((leg) => leg.fareClass).filter((value): value is string => Boolean(value)),
    ),
    origin: str(wire.OriginAirport) ?? segments[0]?.origin,
    destination: str(wire.DestinationAirport) ?? segments.at(-1)?.destination,
    departsLocal: localTime(wire.DepartsAt) ?? segments[0]?.departsLocal,
    arrivesLocal: localTime(wire.ArrivesAt) ?? segments.at(-1)?.arrivesLocal,
    distance: num(wire.TotalSegmentDistance) ?? total(segments.map((leg) => leg.distance)),
    cardRates: cardRates(wire),
    ...(wire.Filtered === true && { filtered: true }),
    segments,
  };
}

export function toBookingLinks(wire: readonly WireBookingLink[] | null | undefined): BookingLink[] {
  return (wire ?? []).map((link) => ({
    label: str(link.label),
    url: str(link.link),
    primary: link.primary === true,
  }));
}

/**
 * Name the routing from whichever fact the API gave us. `minify_trips` supplies
 * `Stops` but no connection airports, so falling through to "" there would
 * silently drop the one routing fact a minified trip does carry.
 */
function routeText(trip: Trip): string {
  if (trip.connections.length > 0) return ` via ${trip.connections.join(', ')}`;
  if (trip.stops === 0) return ' non-stop';
  if (trip.stops === undefined) return '';
  return ` · ${trip.stops} stop${trip.stops === 1 ? '' : 's'}`;
}

/** The text mirror for one trip: a summary line plus one line per leg. */
export function tripLines(trip: Trip): string[] {
  const route = routeText(trip);
  const duration = trip.duration ? ` · ${trip.duration}` : '';
  const dynamic = trip.filtered ? ' · [dynamically priced / filtered]' : '';
  const id = trip.id ? ` [${trip.id}]` : '';
  const cost = `${miles(trip.mileageCost)} + ${taxesText(trip.taxes, trip.source)}`;
  const seats = seatsText(trip.remainingSeats, trip.seatsPublished);
  const head = `▸ ${trip.cabin ?? 'cabin?'} ${cost} · ${seats}${route}${duration}${dynamic}${id}`;
  const cards = trip.cardRates
    .filter((rate) => !rate.filtered)
    .map((rate) => `    with ${rate.card}: ${miles(rate.mileageCost)}`);
  const legs = trip.segments.map((leg) => {
    const aircraft = leg.aircraft ? ` · ${leg.aircraft}` : '';
    const route2 = `${leg.origin ?? '???'}→${leg.destination ?? '???'}`;
    const when = `${leg.departsLocal ?? '?'} → ${leg.arrivesLocal ?? '?'} (local)`;
    return `    ${leg.flightNumber ?? '??'} ${route2} ${when}${aircraft}`;
  });
  return [head, ...cards, ...legs];
}

/** The text mirror for a program's booking deep links. */
export function bookingLinkLines(links: readonly BookingLink[]): string[] {
  if (links.length === 0) return [];
  return [
    '',
    'Book at:',
    ...links.map(
      (l) => `  ${l.primary ? '★ ' : '  '}${l.label ?? 'link'} — ${l.url ?? '(no url)'}`,
    ),
  ];
}
