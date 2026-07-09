/**
 * The XBRL raw-fact layer for the sec-edgar server: normalizing raw
 * data.sec.gov `units` entries into typed facts, classifying their reporting
 * windows, selecting the reporting unit, and picking the latest-filed fact per
 * period. The statement-assembly logic that consumes these lives in `xbrl.ts`.
 */

// ---------------------------------------------------------------------------
// XBRL facts: parsing, period classification, and fact selection
// ---------------------------------------------------------------------------

/** One reported XBRL fact, normalized from the data.sec.gov shape. */
export interface Fact {
  start: string | null;
  end: string;
  value: number;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string;
  filed: string;
  accession: string;
  frame: string | null;
}

export type PeriodKind = 'annual' | 'quarterly' | 'instant' | 'other';

const DAY_MS = 86_400_000;

/**
 * Classify a fact by its reporting window. Durations tolerate 52/53-week
 * fiscal calendars (annual years run 364–371 days, quarters 91–98). Facts with
 * other windows (six- and nine-month year-to-date figures in 10-Qs) are
 * excluded from period matching so YTD numbers never masquerade as quarters.
 */
export function kindOf(fact: Fact): PeriodKind {
  if (fact.start === null) return 'instant';
  const days = (Date.parse(fact.end) - Date.parse(fact.start)) / DAY_MS;
  if (days >= 330 && days <= 400) return 'annual';
  if (days >= 75 && days <= 115) return 'quarterly';
  return 'other';
}

/** Normalize one raw `units` array entry into a {@link Fact} (or null if unusable). */
export function parseFact(raw: unknown): Fact | null {
  const o = raw as Record<string, unknown>;
  if (typeof o?.end !== 'string' || typeof o.val !== 'number' || typeof o.filed !== 'string') {
    return null;
  }
  return {
    start: typeof o.start === 'string' ? o.start : null,
    end: o.end,
    value: o.val,
    fiscalYear: typeof o.fy === 'number' ? o.fy : null,
    fiscalPeriod: typeof o.fp === 'string' ? o.fp : null,
    form: typeof o.form === 'string' ? o.form : '?',
    filed: o.filed,
    accession: typeof o.accn === 'string' ? o.accn : '',
    frame: typeof o.frame === 'string' ? o.frame : null,
  };
}

/**
 * Pick the reporting unit for a concept's `units` map: the preferred keys in
 * order (e.g. `["USD"]` or `["USD/shares"]`), else the first unit present.
 */
export function pickUnitKey(units: Record<string, unknown>, preferred: string[]): string | null {
  for (const key of preferred) if (Array.isArray(units[key])) return key;
  const first = Object.keys(units).find((key) => Array.isArray(units[key]));
  return first ?? null;
}

/** All normalized facts for one concept in one unit. */
export function factsForUnit(units: Record<string, unknown>, unitKey: string): Fact[] {
  const raw = units[unitKey];
  if (!Array.isArray(raw)) return [];
  const facts: Fact[] = [];
  for (const entry of raw) {
    const fact = parseFact(entry);
    if (fact) facts.push(fact);
  }
  return facts;
}

/** The identity of a fact's reporting window (instants have no start). */
export const periodKey = (start: string | null, end: string): string => `${start ?? ''}|${end}`;

/**
 * Deduplicate facts that report the same window: the same period appears in
 * many filings (originals, comparatives, amendments); the latest-filed fact
 * wins so restated/amended figures are preferred.
 */
export function latestFiledByPeriod(facts: Fact[]): Map<string, Fact> {
  const byPeriod = new Map<string, Fact>();
  for (const fact of facts) {
    const key = periodKey(fact.start, fact.end);
    const existing = byPeriod.get(key);
    if (!existing || fact.filed > existing.filed) byPeriod.set(key, fact);
  }
  return byPeriod;
}

/**
 * Whether a fact's fiscal-year/period stamps describe its own window. The
 * stamps are relative to the FILING, so a comparative re-reported a year later
 * carries the later filing's fy/fp — only facts filed shortly after their
 * window end (an original report or its amendment window) are trusted.
 */
export function fiscalStampsTrusted(kind: 'annual' | 'quarterly' | 'instant', fact: Fact): boolean {
  const gapDays = (Date.parse(fact.filed) - Date.parse(fact.end)) / DAY_MS;
  return gapDays <= (kind === 'annual' ? 365 : 180);
}
