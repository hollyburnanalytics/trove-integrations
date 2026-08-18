/**
 * The one config-reading helper the adapters share.
 *
 * This module used to own the source vocabulary — the schedules, the four
 * type-system fields, the locations — and the validators that held a manifest
 * to it. All of that now lives in `@ontrove/sdk`, behind the single call
 * `validateSourceManifest`, so the words a manifest may use are defined once
 * for every catalog and every runtime rather than once per repo. The two
 * consumers that validated manifests — `scripts/validate-registry.mjs` and
 * `test/contract.test.mjs` — import the SDK directly.
 *
 * What is left is {@link stringList}, which is not vocabulary: it is how an
 * adapter reads a list field a *user* filled in. It stays here, and the module
 * keeps its name so the nine adapters that import it need no edit.
 *
 * @module
 */

/**
 * A config field read as a list of strings.
 *
 * Config is USER INPUT: a `url[]` field can arrive as a bare string (one feed
 * pasted into a list field), as null, or as a list with blanks in it. Every
 * fan-out source did `(context.config.feeds || []).map(...)`, which throws
 * `.map is not a function` mid-sync on the first of those — a whole round lost,
 * cursor included, to a shape the field schema never promised.
 *
 * @param {unknown} value - The raw config value.
 * @returns {string[]} Its non-empty entries, or `[]`.
 */
export function stringList(value) {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}
