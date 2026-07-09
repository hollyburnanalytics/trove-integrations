/**
 * Author-display helpers shared by the gutenberg tools that render book lines:
 * a Gutendex life-year formatter (marking BCE) and the author label it builds.
 */

/** Render a Gutendex year, marking BCE for negatives: 180 → "180", -428 → "428 BCE". */
function formatYear(year: number | null): string {
  if (year === null) return '?';
  return year < 0 ? `${-year} BCE` : String(year);
}

/** Format an author with life years, e.g. `Marcus Aurelius (121–180)`, `Plato (428 BCE–348 BCE)`. */
export function authorLabel(a: {
  name: string;
  birthYear: number | null;
  deathYear: number | null;
}): string {
  if (a.birthYear === null && a.deathYear === null) return a.name;
  return `${a.name} (${formatYear(a.birthYear)}–${formatYear(a.deathYear)})`;
}
