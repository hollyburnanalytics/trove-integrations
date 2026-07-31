import { programFor } from './programs.ts';

/**
 * Miles, money and durations — shared by the availability and trip decoders so
 * a price is formatted the same way wherever it appears.
 *
 * Taxes arrive in **minor units** (`560` is 5.60) on both endpoints. Three
 * mileage programs never publish taxes at all, so a zero from them is a gap
 * rather than a free ticket; the program table decides which case a zero is.
 */

/** Taxes and surcharges for one priced option. */
export interface Taxes {
  /** Decimal amount, converted from the API's minor units. */
  amount: number;
  /** ISO currency code, when the API reports one. */
  currency?: string;
  symbol?: string;
}

/** Numbers arrive as JSON numbers on trips and as strings on availabilities. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `"AA, B6"` → `['AA','B6']`. */
export function csv(value: unknown): string[] {
  return (str(value) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Whether a mileage program publishes taxes at all. Unknown programs: assume yes. */
export function publishesTaxes(source: string | undefined): boolean {
  return programFor(source)?.taxes !== false;
}

/** Whether a mileage program publishes seat counts at all. */
export function publishesSeats(source: string | undefined): boolean {
  return programFor(source)?.seatCounts !== 'no';
}

/**
 * Build a Taxes value from minor units, or `undefined` when there is nothing
 * honest to report — the program publishes no taxes, or the figure is absent.
 */
export function toTaxes(
  minorUnits: unknown,
  currency: unknown,
  symbol: unknown,
  source: string | undefined,
): Taxes | undefined {
  const minor = num(minorUnits);
  if (!publishesTaxes(source) || minor === undefined || minor === 0) return undefined;
  return { amount: minor / 100, currency: str(currency), symbol: str(symbol) };
}

/** Group-separated miles: `12500` → `12,500 mi`. */
export function miles(value: number | undefined): string {
  return value === undefined ? 'miles not reported' : `${value.toLocaleString('en-US')} mi`;
}

/**
 * `9` → `9 seats`, with the gap named rather than shown as a zero.
 *
 * The parenthetical is hedged on purpose. The `seatCounts` column comes from the
 * reference's own table, and live data already contradicts it — Qantas is listed
 * as publishing no seat counts and returned `YRemainingSeats: 4`. A real count
 * always wins over the table, so the table can only ever soften an explanation
 * of a *missing* number, never contradict one that is present.
 */
export function seatsText(seats: number | undefined, published: boolean): string {
  if (seats !== undefined && seats > 0) return `${seats} seat${seats === 1 ? '' : 's'}`;
  return published
    ? 'seats not reported'
    : "seats not reported (this program usually doesn't publish them)";
}

/** The taxes phrase — explicit about which kind of nothing a missing figure is. */
export function taxesText(taxes: Taxes | undefined, source: string | undefined): string {
  if (!publishesTaxes(source)) return 'taxes not published by this program';
  if (!taxes) return 'taxes not reported';
  const money = `${taxes.symbol ?? ''}${taxes.amount.toFixed(2)}`;
  return taxes.currency ? `${money} ${taxes.currency}` : `${money} (currency not reported)`;
}

/** Minutes → `18h 53m`. */
export function fmtDuration(minutes: number | undefined): string | undefined {
  if (minutes === undefined || minutes <= 0) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
