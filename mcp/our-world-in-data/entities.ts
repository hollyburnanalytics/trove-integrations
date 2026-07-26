import {
  type ChartMetadata,
  type Ctx,
  columnIndicatorId,
  fetchIndicatorMetadata,
} from './client.ts';
import type { CsvRow } from './csv.ts';

/**
 * Resolving which entities a caller actually asked for.
 *
 * This exists because grapher's `country` parameter is unforgiving in two
 * different ways, both of which fail silently with an HTTP 200:
 *
 *  - it is **case-sensitive** (`JPN` works, `jpn` returns nothing), and
 *  - it does not bind at all on a chart whose view is the world map, which
 *    answers with every country instead.
 *
 * So a request is treated as an intention, not an instruction: ask, check what
 * came back, correct the spelling and ask again if needed, and enforce the
 * selection here regardless of what the upstream chose to send.
 */

/** Every entity on a chart, indexed for case-insensitive lookup. */
export interface EntityIndex {
  /** Canonical display names, for suggestions. */
  names: string[];
  /** lowercased name OR code → the canonical name grapher will accept. */
  canonical: Map<string, string>;
}

/**
 * How many of a chart's indicators contribute to the entity index.
 *
 * One is not enough. A chart that joins UN IGME child mortality to World Bank
 * health spending has genuinely different coverage per indicator, so an entity
 * carried by the second and not the first was being reported as "not an entity
 * on this chart" — a confident denial of something the chart plots. Three
 * bounds the cost on what is already a failure path, and the responses are
 * cached.
 */
const INDEXED_INDICATORS = 3;

/** Build the entity index for a chart, unioned across its first few indicators. */
export async function chartEntities(
  ctx: Ctx,
  metadata: ChartMetadata | undefined,
): Promise<EntityIndex | undefined> {
  const ids = Object.values(metadata?.columns ?? {})
    .map((column) => columnIndicatorId(column))
    .filter((id): id is number => typeof id === 'number')
    .slice(0, INDEXED_INDICATORS);
  if (ids.length === 0) return undefined;

  const index: EntityIndex = { names: [], canonical: new Map() };
  for (const id of ids) {
    const indicator = await fetchIndicatorMetadata(ctx, id);
    addEntities(index, indicator?.dimensions?.entities?.values ?? []);
  }
  return index.canonical.size === 0 ? undefined : index;
}

/** Fold one indicator's entity list into the index, keeping the first spelling seen. */
function addEntities(
  index: EntityIndex,
  values: Array<{ name?: string | null; code?: string | null }>,
): void {
  for (const value of values) {
    const name = typeof value.name === 'string' ? value.name : '';
    if (name === '' || index.canonical.has(name.toLowerCase())) continue;
    index.names.push(name);
    index.canonical.set(name.toLowerCase(), name);
    if (typeof value.code === 'string' && value.code !== '') {
      index.canonical.set(value.code.toLowerCase(), name);
    }
  }
}

/**
 * The requested entities that no returned row accounts for.
 *
 * Matching is case-insensitive on either the entity name or its code, so this
 * reports a genuine miss rather than a difference in spelling.
 */
export function unmatchedRequests(rows: CsvRow[], countries: string[]): string[] {
  const present = new Set<string>();
  for (const row of rows) {
    present.add(row.entity.toLowerCase());
    if (row.code !== null) present.add(row.code.toLowerCase());
  }
  return countries.filter((country) => !present.has(country.toLowerCase()));
}

/**
 * Levenshtein distance, abandoned once it provably exceeds `limit`.
 *
 * Two rows of state rather than a full matrix: the entity list runs to a few
 * hundred names and this is called once per unmatched input, on an error path.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = distanceRow(a.charAt(i - 1), b, previous, i);
    // Every remaining path costs at least the best cell on this row.
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** One row of the edit-distance matrix, given the row above it. */
function distanceRow(ch: string, b: string, previous: number[], rowIndex: number): number[] {
  const current = [rowIndex];
  for (let j = 1; j <= b.length; j++) {
    const cost = ch === b.charAt(j - 1) ? 0 : 1;
    current.push(
      Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
    );
  }
  return current;
}

/**
 * Up to three plausible spellings of `wanted` among `names`.
 *
 * Containment alone is not enough — the mistakes people actually make are
 * typos ("United Kingdon"), which contain nothing and are contained by nothing.
 * A small edit-distance budget, scaled to the length of the word, catches those
 * without proposing nonsense for a genuinely unrelated name.
 */
function suggestions(wanted: string, names: string[]): string[] {
  const needle = wanted.trim().toLowerCase();
  // A substring match is only evidence when the substring is distinctive.
  // "us" is contained in Australia, Austria and Belarus — proposing those for
  // someone who typed "us" is worse than proposing nothing, because it reads as
  // a considered answer.
  if (needle.length < 4) return [];
  const budget = Math.min(3, Math.floor(needle.length / 4));
  const scored: Array<{ name: string; distance: number }> = [];
  for (const name of names) {
    const candidate = name.toLowerCase();
    if (candidate.startsWith(needle) || needle.startsWith(candidate)) {
      scored.push({ name, distance: 0 });
      continue;
    }
    if (candidate.includes(needle) || needle.includes(candidate)) {
      scored.push({ name, distance: 1 });
      continue;
    }
    const distance = editDistance(needle, candidate, budget);
    // Rank a genuine near-miss above a coincidental substring.
    if (distance <= budget) scored.push({ name, distance: distance === 0 ? 0 : distance + 1 });
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'en'));
  return scored.slice(0, 3).map((s) => s.name);
}

/** Explain the requested entities that produced no rows even after repair. */
export async function diagnoseMissing(
  ctx: Ctx,
  metadata: ChartMetadata | undefined,
  missing: string[],
  notes: string[],
): Promise<void> {
  const entities = await chartEntities(ctx, metadata).catch(() => undefined);
  if (!entities) {
    notes.push(
      `No data returned for: ${missing.map((m) => `"${m}"`).join(', ')}. Check the spelling — entity names are Our World in Data’s own (e.g. "United States", "World") or ISO-3 codes (e.g. "USA").`,
    );
    return;
  }
  const unknown = missing.filter((name) => !entities.canonical.has(name.toLowerCase()));
  const known = missing.filter((name) => entities.canonical.has(name.toLowerCase()));
  if (known.length > 0) {
    notes.push(
      `On this chart but with no data in the requested range: ${known.map((k) => `"${k}"`).join(', ')}. Try a wider \`time\`, or omit it.`,
    );
  }
  if (unknown.length > 0) {
    const detail = unknown
      .map((name) => {
        const hints = suggestions(name, entities.names);
        return hints.length > 0 ? `"${name}" (did you mean: ${hints.join(', ')}?)` : `"${name}"`;
      })
      .join('; ');
    notes.push(`Not entities on this chart: ${detail}.`);
  }
}

/**
 * Keep only the rows the caller actually asked for.
 *
 * The `country` parameter is a REQUEST, not a guarantee. It binds to a chart's
 * line view; on a chart whose only view is the world map there is no entity
 * selection to bind to, and grapher answers with every country while returning
 * a perfectly healthy 200. Handing back 250 countries under the heading of the
 * one that was asked for is the worst failure this tool could have — so the
 * selection is enforced here as well as requested there.
 *
 * Matching is on the entity name or its ISO code, case-insensitively, so
 * "USA", "usa" and "United States" all select the same rows.
 */
export function selectEntities(rows: CsvRow[], countries: string[]): CsvRow[] {
  if (countries.length === 0) return rows;
  const wanted = new Set(countries.map((c) => c.trim().toLowerCase()).filter((c) => c !== ''));
  if (wanted.size === 0) return rows;
  return rows.filter(
    (row) =>
      wanted.has(row.entity.toLowerCase()) ||
      (row.code !== null && wanted.has(row.code.toLowerCase())),
  );
}
