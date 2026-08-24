import { type CabinOffer, cabinLines, cabinOffers } from './cabins.ts';
import { num, str } from './money.ts';
import { programName } from './programs.ts';
import { type Trip, toTrip, tripLines } from './trips.ts';
import type { Cursor, WireAvailability, WireAvailabilityPage } from './wire.ts';

/**
 * Availability summaries and paging.
 *
 * The cabin decoding — where this API is most easily misread — lives in
 * `cabins.ts`. What remains here is the record around it and the honest
 * reporting of a page:
 *
 * **`count` is the page size, not a total.** Observed live: `take=10` answers
 * `count: 10` with `hasMore: true`, on both the search and the bulk endpoints.
 * So it can never say how much matched, and it is passed through under a name
 * that says what it is rather than being used for a total.
 */

/** A route + date + program summary, with only the cabins actually available. */
export interface Availability {
  id?: string;
  source?: string;
  program: string;
  date?: string;
  origin?: string;
  destination?: string;
  originRegion?: string;
  destinationRegion?: string;
  distance?: number;
  updatedAt?: string;
  cabins: CabinOffer[];
  /** Present only when the search was made with `include_trips`. */
  trips?: Trip[];
}

/** What the caller needs to ask for the next page — nothing is auto-paged. */
export interface PageInfo {
  /** How many results this page actually carried. Authoritative. */
  returned: number;
  hasMore: boolean;
  /**
   * Pass back verbatim on the next call to keep the ordering stable. Opaque by
   * the API's own instruction — a Unix timestamp "currently" — so it is echoed
   * rather than parsed, and both tools accept it back as either type.
   */
  cursor?: Cursor;
  /** The `skip` for the next call: everything retrieved for this search so far. */
  nextSkip?: number;
  /** The API's own next-page path, when it supplies one (`moreURL`). */
  moreUrl?: string;
  /**
   * Seats.aero's `count` field. Observed to equal the page size, so it is
   * reported under its own name and never used as a total.
   */
  reportedCount?: number;
}

/** Map one wire availability into the tool's shape. */
export function toAvailability(wire: WireAvailability): Availability {
  const route = wire.Route ?? {};
  const source = str(wire.Source) ?? str(route.Source);
  // Embedded trips inherit the program and currency from their parent, which is
  // the only place they exist when `minify_trips` is on.
  const context = {
    source,
    taxesCurrency: str(wire.TaxesCurrency),
    taxesSymbol: undefined,
  };
  const trips = (wire.AvailabilityTrips ?? []).map((trip) => toTrip(trip, context));
  return {
    id: str(wire.ID),
    source,
    program: programName(source),
    date: str(wire.Date),
    origin: str(route.OriginAirport),
    destination: str(route.DestinationAirport),
    originRegion: str(route.OriginRegion),
    destinationRegion: str(route.DestinationRegion),
    distance: num(route.Distance),
    updatedAt: str(wire.UpdatedAt),
    cabins: cabinOffers(wire),
    ...(trips.length > 0 && { trips }),
  };
}

/** Decode a `{ data, count, hasMore, moreURL, cursor }` page. */
export function toPage(
  body: WireAvailabilityPage | undefined,
  skip: number,
): { results: Availability[]; page: PageInfo } {
  const results = (body?.data ?? []).map((item) => toAvailability(item));
  const hasMore = body?.hasMore === true;
  return {
    results,
    page: {
      returned: results.length,
      hasMore,
      cursor: body?.cursor ?? undefined,
      ...(hasMore && { nextSkip: skip + results.length }),
      moreUrl: str(body?.moreURL),
      reportedCount: num(body?.count),
    },
  };
}

/** The text mirror for one availability, plus its trips when they were fetched. */
export function availabilityLines(item: Availability): string[] {
  const id = item.id ? `  [${item.id}]` : '';
  const route = `${item.origin ?? '???'}→${item.destination ?? '???'}`;
  const header = `• ${item.date ?? 'unknown date'}  ${route}  ${item.program}${id}`;
  return [
    header,
    ...item.cabins.flatMap((offer) => cabinLines(offer, item.source)),
    ...(item.trips ?? []).flatMap((trip) => tripLines(trip).map((line) => `  ${line}`)),
  ];
}

/**
 * The pagination footer.
 *
 * It recommends **widening `take`, not paging**, because `skip` was measured and
 * does not enumerate the result set. With the data provably static — the same
 * query repeated returns the same twenty ids in the same order, cursor or no
 * cursor — paging that same query as 10 + 10 recovered **10 of the 20**, repeated
 * 3, and returned 7 the single call never contained. `order_by=lowest_mileage`
 * is worse: 1 of 20. The behaviour fits a sort applied to the *fetched window*
 * rather than to the whole match set, so `skip` is not an offset into a stable
 * ordering, and the cursor does not make it one.
 *
 * A larger `take` costs the same single API call and is bounded only by response
 * size (`take=1001` was served), so it is both cheaper and correct. `skip` and
 * `cursor` stay available — they are the documented mechanism — but they are no
 * longer presented as the route to a complete answer.
 */
export function pageFooter(page: PageInfo): string {
  if (!page.hasMore) return `${page.returned} result(s) — this is the last page.`;
  const resume = [
    page.nextSkip === undefined ? undefined : `skip=${page.nextSkip}`,
    page.cursor === undefined ? undefined : `cursor=${page.cursor}`,
  ]
    .filter(Boolean)
    .join(' and ');
  return [
    `${page.returned} result(s) shown and MORE ARE AVAILABLE.`,
    'TO SEE THEM, RAISE take AND RE-RUN — it costs the same single API call.',
    `Paging (${resume}) is available but measured as lossy: it both repeats and OMITS results, because Seats.aero sorts the page it fetched rather than the whole match set. If you do page, de-duplicate by id and do not treat the union as complete.`,
  ].join(' ');
}

/** Assemble the full text mirror for a page of availabilities. */
export function renderPage(
  heading: string,
  results: Availability[],
  page: PageInfo,
  notes: string[],
  max = 40,
): string {
  const shown = results.slice(0, max);
  const clipped =
    results.length > shown.length
      ? [`… ${results.length - shown.length} more in this page omitted from the summary.`]
      : [];
  const body =
    results.length > 0
      ? shown.flatMap((item) => availabilityLines(item))
      : [
          'No award availability matched this search.',
          'Every filter narrows silently — a mileage program that does not serve the',
          'region, a cabin it does not sell, or dates outside its booking window all',
          'return an empty result rather than an error. Widen one filter at a time.',
        ];
  return [
    heading,
    ...notes.map((note) => `NOTE: ${note}`),
    '',
    ...body,
    ...clipped,
    '',
    pageFooter(page),
  ].join('\n');
}
