/**
 * Typed watermark values for connector cursors.
 *
 * The cloud stores `sources.cursor` as an opaque JSON string; these helpers give
 * every connector a single, tagged shape to read and write. See
 * docs/connector-taxonomy.md §8.3 for the full union.
 *
 * MVP implements three strategies: `date`, `idSet` (bounded), and `none`
 * (no cursor at all — the connector returns `undefined`).
 */

/**
 * Default cap on an `idSet` watermark. Keeps the cursor finite so a long-lived
 * scrape can't grow it without bound. Evicting an old id at worst
 * causes that page to be re-scraped once and deduped server-side by external id.
 */
export const DEFAULT_ID_SET_MAX = 10_000;

/**
 * Read a `date` watermark as a `Date`, or `undefined` when absent/unparseable.
 *
 * @param {unknown} cursor - the connector's previous cursor (`ctx.cursor`)
 * @returns {Date | undefined}
 */
export function readDateWatermark(cursor) {
  const wm = /** @type {{ type?: string; value?: string } | undefined} */ (cursor);
  const iso = wm?.type === 'date' ? wm.value : undefined;
  if (!iso) return;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Build a typed `date` watermark from an ISO-8601 string. Pass `inclusive` when
 * the boundary item itself should be re-emitted (a `>=` comparison) rather than
 * skipped (the default strict `>`).
 *
 * @param {string} valueIso
 * @param {{ inclusive?: boolean }} [options]
 * @returns {{ type: 'date', value: string, inclusive?: true }}
 */
export function dateWatermark(valueIso, { inclusive = false } = {}) {
  return inclusive
    ? { type: 'date', value: valueIso, inclusive: true }
    : { type: 'date', value: valueIso };
}

/**
 * The date cursor to return from a run whose sub-sources (feeds, sections,
 * tickers, channels, meeting types) may have individually failed.
 *
 * Two safety rules, both protecting the invariant that a date watermark never
 * moves past unfetched work:
 *
 * 1. **Hold on failure.** When any sub-source failed, return the previous
 *    cursor unchanged. Advancing on the healthy sub-sources' max date would
 *    permanently skip the failed sub-source's items older than that date —
 *    per-sub-source try/catch "resilience" silently trading availability for
 *    data loss. Held back, the next run re-fetches the window and the
 *    server's (source, external id) dedup absorbs the re-emitted documents.
 *
 * 2. **Clamp to now.** A future-dated item (a scheduled meeting, a post-dated
 *    article) must not drag the watermark past the present, which would make
 *    everything published between now and that future date invisible.
 *
 * @param {object} args
 * @param {unknown} args.previous - the incoming `ctx.cursor`, returned when holding
 * @param {string | undefined} args.maxIso - max ISO date across this run's items
 * @param {boolean} args.anyFailed - whether any sub-source failed this run
 * @param {boolean} [args.inclusive] - see {@link dateWatermark}
 * @returns the cursor to return from `sync`
 */
export function advanceDateWatermark({ previous, maxIso, anyFailed, inclusive = false }) {
  if (anyFailed || !maxIso) return previous;
  const nowIso = new Date().toISOString();
  // Lexicographic min of two ISO-8601 strings — Math.min would coerce to NaN.
  // eslint-disable-next-line unicorn/prefer-math-min-max
  const advanceTo = maxIso > nowIso ? nowIso : maxIso;
  return dateWatermark(advanceTo, { inclusive });
}

/**
 * Read an `idSet` watermark as a string array (empty when absent).
 *
 * @param {unknown} cursor - the connector's previous cursor (`ctx.cursor`)
 * @returns {string[]}
 */
export function readIdSet(cursor) {
  const wm = /** @type {{ type?: string; values?: string[] } | undefined} */ (cursor);
  return wm?.type === 'idSet' ? (wm.values ?? []) : [];
}

/**
 * Build a typed `idSet` watermark, deduped and bounded to `max` entries
 * (the newest are kept). Input order is oldest-first, newest-last.
 *
 * @param {string[]} values - ids/URLs seen so far (oldest first)
 * @param {number} [max] - cap on retained entries (default {@link DEFAULT_ID_SET_MAX})
 * @returns {{ type: 'idSet', values: string[], max: number }}
 */
export function idSetWatermark(values, max = DEFAULT_ID_SET_MAX) {
  const unique = [...new Set(values)];
  const bounded = unique.length > max ? unique.slice(unique.length - max) : unique;
  return { type: 'idSet', values: bounded, max };
}
