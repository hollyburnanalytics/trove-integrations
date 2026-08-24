import {
  csv,
  hasPublishedSeats,
  miles,
  num,
  seatsText,
  str,
  type Taxes,
  taxesText,
  toTaxes,
} from './money.ts';
import { CABIN_PREFIX, CABINS, type Cabin } from './programs.ts';
import type { WireAvailability } from './wire.ts';

/**
 * Decoding one availability's cabin fields — the part of this API most likely to
 * be reported wrongly, because the field names invite it.
 *
 * An availability carries **four** parallel views of every cabin, keyed by
 * prefix, and only one of them is in the published reference:
 *
 * | field | means |
 * |---|---|
 * | `JMileageCost` | cheapest business itinerary of **any** routing |
 * | `JDirectMileageCost` | cheapest business **non-stop** |
 * | `…Raw` on either | the same, **before** the dynamic-pricing filter |
 *
 * These genuinely differ. United SFO→LHR on 2026-09-01 is 40,000 miles in
 * economy connecting through ORD, and **65,400 non-stop** — so pairing
 * `YMileageCost` with the `YDirect` boolean, as the reference's field list
 * invites, reports the connecting price as the price of a non-stop. The two
 * shapes are therefore decoded as two separate offers and labelled.
 *
 * The `Raw` view is what `include_filtered` exists to reach: a cabin can be
 * entirely absent from the filtered fields (`WAvailable: false`, every figure 0)
 * while the raw fields carry a real, very expensive dynamically-priced award
 * (135,900 miles, 9 seats, non-stop on UA). Reading only the filtered fields
 * would make `include_filtered` look like it did nothing.
 */

/** The cheapest itinerary of one shape, in one cabin. */
export interface Offer {
  mileageCost?: number;
  remainingSeats?: number;
  airlines: string[];
  taxes?: Taxes;
}

/** Co-brand credit-card pricing, which several US programs publish inline. */
export interface CardRate {
  /** The card's code as Seats.aero names it, e.g. `UACARD`, `UAELITECARD`. */
  card: string;
  mileageCost?: number;
  nonStopMileageCost?: number;
  unlockedAirlines: string[];
}

/** One cabin's award space, split by routing shape and by pricing filter. */
export interface CabinOffer {
  cabin: Cabin;
  /** Cheapest of any routing. Absent when the cabin survives only unfiltered. */
  best?: Offer;
  /** Cheapest non-stop, when one exists. Often dearer than `best`. */
  nonStop?: Offer;
  /** True when `best` is achievable without a connection. */
  bestIsNonStop: boolean;
  /**
   * The same pair **before** Seats.aero's dynamic-pricing filter. Present only
   * when the unfiltered view shows something the filtered one does not, which
   * only happens when `include_filtered` was requested.
   */
  dynamic?: { best?: Offer; nonStop?: Offer };
  /** Card-discounted rates for this cabin, when the program publishes them. */
  cardRates: CardRate[];
  /** False when this program never publishes seat counts. */
  seatsPublished: boolean;
}

/**
 * Read one offer out of the prefixed key space.
 *
 * The key is assembled as `<cabin><Direct?><field><Raw?>` — the routing marker
 * is an infix and the filter marker a suffix, so business non-stop unfiltered
 * is `JDirectMileageCostRaw`. Getting that order wrong reads a key that does not
 * exist, which decodes as "no availability" rather than as an error.
 */
function offer(
  wire: WireAvailability,
  prefix: string,
  shape: { direct: boolean; raw: boolean },
  source: string | undefined,
): Offer | undefined {
  const key = (field: string): string =>
    `${prefix}${shape.direct ? 'Direct' : ''}${field}${shape.raw ? 'Raw' : ''}`;
  const cost = num(wire[key('MileageCost')]);
  if (cost === undefined || cost === 0) return undefined;
  const seats = num(wire[key('RemainingSeats')]);
  return {
    mileageCost: cost,
    remainingSeats: seats !== undefined && seats > 0 ? seats : undefined,
    airlines: csv(wire[key('Airlines')]),
    taxes: toTaxes(wire[key('TotalTaxes')], wire.TaxesCurrency, undefined, source),
  };
}

/** Read this cabin's co-brand card rates out of `OptionalPricing`. */
function cardRates(wire: WireAvailability, prefix: string): CardRate[] {
  const pricing = wire.OptionalPricing;
  if (typeof pricing !== 'object' || pricing === null) return [];
  const rates: CardRate[] = [];
  for (const [card, value] of Object.entries(pricing as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const block = value as Record<string, unknown>;
    const cost = num(block[prefix]);
    if (cost === undefined || cost === 0) continue;
    rates.push({
      card,
      mileageCost: cost,
      nonStopMileageCost: num(block[`${prefix}Direct`]) || undefined,
      unlockedAirlines: csv(block[`${prefix}UnlockedAirlines`]),
    });
  }
  return rates;
}

/** Decode one cabin, or `undefined` when it is unavailable in every view. */
export function cabinOffer(wire: WireAvailability, cabin: Cabin): CabinOffer | undefined {
  const prefix = CABIN_PREFIX[cabin];
  const source = str(wire.Source);
  const isAvailable = wire[`${prefix}Available`] === true;
  const isAvailableRaw = wire[`${prefix}AvailableRaw`] === true;
  if (!isAvailable && !isAvailableRaw) return undefined;

  const best = isAvailable ? offer(wire, prefix, { direct: false, raw: false }, source) : undefined;
  const nonStop = isAvailable
    ? offer(wire, prefix, { direct: true, raw: false }, source)
    : undefined;
  const rawBest = offer(wire, prefix, { direct: false, raw: true }, source);
  const rawNonStop = offer(wire, prefix, { direct: true, raw: true }, source);

  // Only carry the unfiltered view when it says something the filtered one
  // doesn't — otherwise every result would repeat itself. Note the `Raw` fields
  // ride along on *every* row, not only with `include_filtered`: that flag
  // controls which rows are returned, not which fields they carry. So this block
  // legitimately appears on ordinary searches, and it is how a cabin that exists
  // only at dynamic pricing stops reading as "no availability".
  const hasDynamicAdds =
    (rawBest !== undefined && rawBest.mileageCost !== best?.mileageCost) ||
    (rawNonStop !== undefined && rawNonStop.mileageCost !== nonStop?.mileageCost);

  // A cabin flagged available in neither view with nothing priced in either is
  // not a result; emitting it would render as an empty bullet.
  if (best === undefined && !hasDynamicAdds) return undefined;

  return {
    cabin,
    best,
    nonStop,
    bestIsNonStop: best !== undefined && best.mileageCost === nonStop?.mileageCost,
    ...(hasDynamicAdds && { dynamic: { best: rawBest, nonStop: rawNonStop } }),
    cardRates: cardRates(wire, prefix),
    seatsPublished: hasPublishedSeats(source),
  };
}

/** Every available cabin on one availability, cheapest cabin class first. */
export function cabinOffers(wire: WireAvailability): CabinOffer[] {
  return CABINS.map((cabin) => cabinOffer(wire, cabin)).filter(
    (found): found is CabinOffer => found !== undefined,
  );
}

/** `40,000 mi + $5.60 USD · 9 seats · UA`. */
function offerText(item: Offer, arePublishedSeats: boolean, source: string | undefined): string {
  const carriers = item.airlines.length > 0 ? ` · ${item.airlines.join(', ')}` : '';
  return `${miles(item.mileageCost)} + ${taxesText(item.taxes, source)} · ${seatsText(
    item.remainingSeats,
    arePublishedSeats,
  )}${carriers}`;
}

/**
 * The text mirror for one cabin. The routing shape of each price is stated
 * outright, because "40,000 miles" and "non-stop" are only the same claim when
 * the API says the cheapest routing happens to be the non-stop one.
 */
export function cabinLines(item: CabinOffer, source: string | undefined): string[] {
  const lines: string[] = [];
  const label = item.cabin.padEnd(8);
  if (item.best) {
    const shape = item.bestIsNonStop ? 'non-stop' : 'with a connection';
    lines.push(`    ${label} ${offerText(item.best, item.seatsPublished, source)} · ${shape}`);
  }
  if (item.nonStop && !item.bestIsNonStop) {
    lines.push(
      `             cheapest non-stop: ${offerText(item.nonStop, item.seatsPublished, source)}`,
    );
  }
  if (item.best && !item.nonStop) lines.push('             no non-stop option');
  for (const rate of item.cardRates) {
    lines.push(
      `             with ${rate.card}: ${miles(rate.mileageCost)}${
        rate.nonStopMileageCost ? ` (non-stop ${miles(rate.nonStopMileageCost)})` : ''
      }`,
    );
  }
  // The dynamic block is spelled out only when the filtered view has nothing for
  // this cabin. That is the case where staying silent would read as "no space in
  // this cabin" when there is some, just at a dynamic price. Where a normal
  // award already exists, the dearer alternative is noise in the prose — it
  // stays in the structured result either way.
  const dynamic = item.dynamic?.best ?? item.dynamic?.nonStop;
  if (dynamic && !item.best) {
    const shape = item.dynamic?.best ? '' : ' non-stop';
    lines.push(
      `    ${label} ONLY at dynamic pricing${shape}: ${offerText(
        dynamic,
        item.seatsPublished,
        source,
      )}`,
    );
  }
  return lines;
}
