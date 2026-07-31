import { ToolError } from '@ontrove/mcp';

/**
 * The mileage programs ("sources") the Seats.aero partner API covers, plus the
 * cabin vocabulary both halves of the API speak.
 *
 * This table is transcribed from the API's own Concepts page, and it is here for
 * one reason: **a wrong or unsupported source is a silently empty answer**, not
 * an error. `sources=aeroplane` returns `{"data":[],"hasMore":false}` with an
 * HTTP 200, which reads exactly like "no award space on that route". Validating
 * against the documented list turns that into a named mistake and — since Pro
 * accounts get 1,000 calls a day — spends no quota finding out.
 *
 * The per-program capability flags matter for the same reason: several programs
 * never report seat counts or taxes, and without the table a zero would be
 * presented as fact.
 *
 * **This table is documentation, and documentation drifts.** Sampling 300 live
 * records from each of the 26 programs contradicted the reference on eight of
 * them: five listed as publishing no seat counts do publish them (emirates,
 * qantas, qatar, turkish, singapore — leaving only azul and frontier genuinely
 * silent), two listed as publishing taxes never did in the sample (eurobonus,
 * ethiopian), and Lufthansa sells a premium-economy cabin the table omits.
 * Corrections below are marked `[live]`.
 *
 * Two rules follow, and they are what keep the table safe rather than the
 * corrections themselves:
 *
 * 1. **Observed data always wins.** The flags only ever soften the explanation
 *    of a *missing* value; a number the API actually sent is reported as-is.
 * 2. **Nothing here refuses a query.** A cabin the table does not list produces
 *    a note, never a refusal — the Lufthansa row is exactly the case where a
 *    refusal would have blocked a search that returns real availability.
 */

export const CABINS = ['economy', 'premium', 'business', 'first'] as const;
export type Cabin = (typeof CABINS)[number];

/**
 * Availability objects encode each cabin as a one-letter field prefix
 * (`YMileageCost`, `JDirect`, `FRemainingSeats`), while requests spell the cabin
 * out. Both directions are needed.
 */
export const CABIN_PREFIX: Record<Cabin, string> = {
  economy: 'Y',
  premium: 'W',
  business: 'J',
  first: 'F',
};

/** Regions the bulk-availability endpoint accepts for origin/destination. */
export const REGIONS = [
  'North America',
  'South America',
  'Africa',
  'Asia',
  'Europe',
  'Oceania',
] as const;
export type Region = (typeof REGIONS)[number];

/** How faithfully a program reports remaining seats, per the Concepts table. */
export type SeatCountSupport = 'yes' | 'partial' | 'no';

export interface Program {
  /** The `source` slug the API takes and returns. */
  source: string;
  /** The mileage program's marketing name. */
  name: string;
  /** Cabins this program is searchable in. */
  cabins: readonly Cabin[];
  /** Whether remaining-seat counts come back at all. */
  seatCounts: SeatCountSupport;
  /** Whether taxes and surcharges are reported for this program. */
  taxes: boolean;
}

const ALL = CABINS;
const Y: readonly Cabin[] = ['economy'];
const YJ: readonly Cabin[] = ['economy', 'business'];
const YWJ: readonly Cabin[] = ['economy', 'premium', 'business'];
const YJF: readonly Cabin[] = ['economy', 'business', 'first'];

/** `[source, name, cabins, seat counts, publishes taxes]`, per the Concepts table. */
type Row = readonly [string, string, readonly Cabin[], SeatCountSupport, boolean];

const TABLE: readonly Row[] = [
  ['eurobonus', 'SAS EuroBonus', YJ, 'yes', true],
  ['virginatlantic', 'Virgin Atlantic Flying Club', YWJ, 'yes', true],
  ['aeromexico', 'Aeromexico Club Premier', YWJ, 'yes', true],
  ['american', 'American Airlines', ALL, 'partial', true],
  ['delta', 'Delta SkyMiles', YWJ, 'yes', true],
  ['etihad', 'Etihad Guest', YJF, 'yes', true],
  ['united', 'United MileagePlus', ALL, 'yes', true],
  ['emirates', 'Emirates Skywards', ALL, 'yes', true], // [live] docs say no seats
  ['aeroplan', 'Air Canada Aeroplan', ALL, 'yes', true],
  // Seats.aero's own booking links say "Alaska Atmos Rewards"; the Concepts
  // table still says Mileage Plan. Both spellings are kept so a caller searching
  // either name gets a suggestion.
  ['alaska', 'Alaska Atmos Rewards (formerly Mileage Plan)', ALL, 'yes', true],
  ['velocity', 'Virgin Australia Velocity', ALL, 'yes', true],
  ['qantas', 'Qantas Frequent Flyer', ALL, 'partial', true], // [live] docs say no seats
  ['connectmiles', 'Copa ConnectMiles', YJF, 'no', true],
  ['azul', 'Azul TudoAzul', YJ, 'no', true],
  ['smiles', 'GOL Smiles', ALL, 'yes', true],
  ['flyingblue', 'Air France/KLM Flying Blue', ALL, 'yes', true],
  ['jetblue', 'JetBlue TrueBlue', ALL, 'yes', true],
  ['qatar', 'Qatar Privilege Club', YJF, 'yes', false], // [live] docs say no seats
  ['turkish', 'Turkish Miles & Smiles', YJ, 'partial', false], // [live] docs say no seats
  ['singapore', 'Singapore KrisFlyer', ALL, 'yes', false], // [live] docs say no seats
  ['ethiopian', 'Ethiopian ShebaMiles', YJ, 'yes', true],
  ['saudia', 'Saudi AlFursan', YJF, 'yes', true],
  ['finnair', 'Finnair Plus', ALL, 'yes', true],
  ['lufthansa', 'Lufthansa Miles & More', ALL, 'yes', true], // [live] docs omit premium
  ['frontier', 'Frontier Airlines', Y, 'no', true],
  ['spirit', 'Spirit Airlines', Y, 'yes', true],
];

/** Every documented mileage program, in the Concepts page's own order. */
export const PROGRAMS: readonly Program[] = TABLE.map(
  ([source, name, cabins, seatCounts, taxes]) => ({ source, name, cabins, seatCounts, taxes }),
);

const BY_SOURCE = new Map(PROGRAMS.map((p) => [p.source, p]));

/** Look up a program by slug; `undefined` for a slug this table has never heard of. */
export function programFor(source: string | undefined): Program | undefined {
  return source ? BY_SOURCE.get(source.toLowerCase()) : undefined;
}

/** A program's display name, falling back to the raw slug for an unknown source. */
export function programName(source: string | undefined): string {
  return programFor(source)?.name ?? source ?? 'unknown program';
}

/** Slugs whose name or slug contains `needle` — used to repair a near miss. */
function suggestions(needle: string): string[] {
  const q = needle.toLowerCase();
  return PROGRAMS.filter(
    (p) => p.source.includes(q) || p.name.toLowerCase().includes(q) || q.includes(p.source),
  ).map((p) => p.source);
}

/**
 * Validate mileage-program slugs, naming any the API does not publish rather
 * than passing them on to be answered with an empty page.
 */
export function resolveSources(input: readonly string[], field: string): string[] {
  const wanted = input.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((s) => !BY_SOURCE.has(s));
  if (unknown.length > 0) {
    const hints = unknown.flatMap((s) => suggestions(s));
    const near = hints.length > 0 ? ` Did you mean ${[...new Set(hints)].join(', ')}?` : '';
    throw new ToolError(
      `${field}: ${unknown.join(', ')} ${
        unknown.length === 1 ? 'is not a' : 'are not'
      } Seats.aero mileage program${unknown.length === 1 ? '' : 's'}.${near} Call list_programs for the full list.`,
      { retryable: false },
    );
  }
  return [...new Set(wanted)];
}

/**
 * Note when a cabin/source combination looks unlikely to produce results —
 * several programs are not searchable in every cabin, and asking anyway returns
 * an empty page that reads as "no award space".
 *
 * This **notes and never refuses**, which is a deliberate change from an earlier
 * version that threw when no requested program listed the cabin. Live sampling
 * found Lufthansa selling premium economy that the reference table omits, so
 * that refusal would have blocked a search returning real availability. A table
 * transcribed from documentation is not a good enough reason to decline to ask.
 */
export function cabinCoverageNotes(sources: string[], cabins: Cabin[]): string[] {
  if (sources.length === 0 || cabins.length === 0) return [];
  const notes: string[] = [];
  let possible = 0;
  for (const source of sources) {
    const program = programFor(source);
    if (!program) continue;
    const missing = cabins.filter((c) => !program.cabins.includes(c));
    if (missing.length < cabins.length) possible += 1;
    if (missing.length > 0) {
      notes.push(
        `Seats.aero documents ${program.name} (${source}) as covering ${program.cabins.join('/')}, not ${missing.join('/')} — an empty result may mean that rather than no award space. The search still ran; the documented cabin list has been wrong before.`,
      );
    }
  }
  if (possible === 0) {
    notes.push(
      `No requested mileage program is documented as covering ${cabins.join('/')}. Searching anyway, because that list is documentation rather than ground truth.`,
    );
  }
  return notes;
}
