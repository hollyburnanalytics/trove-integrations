export const VALID_SCHEDULES = [
  'every 30 minutes',
  'every 1 hour',
  'every 2 hours',
  'every 4 hours',
  'every 6 hours',
  'every 12 hours',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'on demand',
];

// ---------------------------------------------------------------------------
// Source type system
//
// Four orthogonal manifest fields describe a source adapter's collection
// contract: `kind` (execution contract), `transport` (mechanism), `watermark`
// (resume strategy), and `documentSemantics` (ingest behavior). Every value is
// defined here so the design is whole and forward-compatible, but only the
// MVP_* subsets are built and enforced today. See
// docs/source-adapter-taxonomy.md §4 for the full formalization and rationale.
// ---------------------------------------------------------------------------

/** Execution contract — which entrypoint the harness invokes. @type {readonly string[]} */
export const SOURCE_KINDS = ['scheduled-sync', 'on-demand-fetch', 'on-demand-query'];

/** Mechanism by which a source adapter reaches its data. @type {readonly string[]} */
export const TRANSPORTS = ['feed', 'scrape', 'api', 'browser', 'local'];

/**
 * Default executor for a source's sync. `cloud` = a Trove-hosted runtime;
 * `client` = the user's own device (the Mac harness). The manifest value is the
 * *default* and the *eligibility bound*: a `cloud` source may be flipped to
 * `client` per user, never the reverse. @type {readonly string[]}
 */
export const LOCATIONS = ['cloud', 'client'];

/**
 * Transports whose sync is a pure HTTP pull, the necessary condition for a
 * source to run in the cloud. @type {readonly string[]}
 */
export const CLOUD_ELIGIBLE_TRANSPORTS = ['feed', 'api', 'scrape'];

/**
 * Config-schema field types a fan-out source may explode into one feed per
 * entry (a list of feed URLs or of query strings).
 * @type {readonly string[]}
 */
export const FAN_OUT_FIELD_TYPES = ['url[]', 'text[]'];

/** Resume strategy declared by a source; the value lives in the feed's cursor. @type {readonly string[]} */
export const WATERMARK_STRATEGIES = [
  'date',
  'idSet',
  'none',
  'highWaterId',
  'opaqueToken',
  'snapshot',
  'mtime',
  'rowid',
];

/** Ingest behavior for a source's documents. @type {readonly string[]} */
export const DOCUMENT_SEMANTICS = ['append', 'upsert'];

/**
 * Whether Trove reformats a source's documents into clean Markdown on ingest,
 * or stores them exactly as received. `reformat` restructures the body — adding
 * headings, paragraph breaks, lists — while preserving the words verbatim (a
 * fidelity gate falls back to the original if the model would alter them);
 * `verbatim` leaves the body untouched. OPTIONAL and defaulted: a manifest that
 * omits `formatting` means `verbatim`, so a new or third-party source never has
 * its data altered unless its author opts in. Deliberately NOT a member of
 * `SOURCE_TYPE_FIELDS` (those are required); validated by {@link validateFormatting}.
 * @type {readonly string[]}
 */
export const FORMATTING = ['reformat', 'verbatim'];

/**
 * The MVP cut: the subset of each type family that the harness and cloud actually
 * build and enforce today. `status: implemented` sources MUST stay within these;
 * stubs may declare deferred values to encode the roadmap.
 */
export const MVP = {
  kinds: ['scheduled-sync'],
  // `local` graduated from the deferred set with apple-podcasts: the runtime
  // imposes nothing transport-specific, so a source adapter reading on-disk
  // data needs no harness support beyond what feed/api sources already use.
  transports: ['feed', 'scrape', 'api', 'browser', 'local'],
  watermarks: ['date', 'idSet', 'none'],
  documentSemantics: ['append'],
};

/** The four type-system fields, with their allowed value sets. @type {Record<string, readonly string[]>} */
export const SOURCE_TYPE_FIELDS = {
  kind: SOURCE_KINDS,
  transport: TRANSPORTS,
  watermark: WATERMARK_STRATEGIES,
  documentSemantics: DOCUMENT_SEMANTICS,
};

/**
 * Validate a manifest's type-system fields. Returns an array of error strings
 * (empty when valid).
 *
 * @param {Record<string, unknown>} manifest - the parsed manifest.json
 * @param {{ implemented: boolean }} options - whether the source has code
 *   (implemented sources are held to the MVP cut; stubs may use deferred values)
 * @returns {string[]} validation errors
 */
export function validateSourceTypeFields(manifest, { implemented }) {
  const mvpByField = {
    kind: MVP.kinds,
    transport: MVP.transports,
    watermark: MVP.watermarks,
    documentSemantics: MVP.documentSemantics,
  };
  const errors = [];
  for (const [field, allowed] of Object.entries(SOURCE_TYPE_FIELDS)) {
    const value = manifest[field];
    if (value === undefined) {
      errors.push(`missing required field "${field}"`);
      continue;
    }
    if (!allowed.includes(/** @type {string} */ (value))) {
      errors.push(`invalid ${field} "${value}" (allowed: ${allowed.join(', ')})`);
      continue;
    }
    if (implemented && !mvpByField[field].includes(value)) {
      errors.push(
        `implemented source uses non-MVP ${field} "${value}" (MVP: ${mvpByField[field].join(', ')})`,
      );
    }
  }
  return errors;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a manifest's `location` field and, for `cloud`, the hard
 * cloud-eligibility predicate:
 *
 *   location: cloud ⇒ transport ∈ {feed, api, scrape}
 *                     ∧ needs_browser ≠ true
 *                     ∧ schedule ≠ "on demand"
 *
 * `location` is required and ∈ {cloud, client}. `client` is always permitted —
 * the Mac harness runs anything.
 *
 * @param {Record<string, unknown>} manifest - the parsed manifest.json
 * @returns {string[]} validation errors (empty when valid)
 */
export function validateLocation(manifest) {
  const location = manifest.location;
  if (location === undefined) return ['missing required field "location"'];
  if (!LOCATIONS.includes(/** @type {string} */ (location))) {
    return [`invalid location "${location}" (allowed: ${LOCATIONS.join(', ')})`];
  }
  if (location !== 'cloud') return [];

  const errors = [];
  if (!CLOUD_ELIGIBLE_TRANSPORTS.includes(/** @type {string} */ (manifest.transport))) {
    errors.push(
      `location "cloud" requires transport ∈ {${CLOUD_ELIGIBLE_TRANSPORTS.join(', ')}} (got "${manifest.transport}")`,
    );
  }
  if (manifest.needs_browser === true) {
    errors.push('location "cloud" is incompatible with needs_browser: true');
  }
  if (manifest.schedule === 'on demand') {
    errors.push('location "cloud" is incompatible with schedule "on demand"');
  }
  return errors;
}

/**
 * Validate a manifest's optional `fanOut` field. When present it
 * must name a key in the manifest's `config` schema whose declared type is a
 * list the runner can explode into one feed per entry (`url[]` or `text[]`).
 *
 * @param {Record<string, unknown>} manifest - the parsed manifest.json
 * @returns {string[]} validation errors (empty when absent or valid)
 */
export function validateFanOut(manifest) {
  const fanOut = manifest.fanOut;
  if (fanOut === undefined) return [];
  if (typeof fanOut !== 'string') {
    return [`invalid fanOut ${JSON.stringify(fanOut)} (must be a string naming a config field)`];
  }
  const config = manifest.config;
  const field = isRecord(config) ? config[fanOut] : undefined;
  if (!isRecord(field)) {
    return [`fanOut "${fanOut}" does not name a field in the config schema`];
  }
  if (!FAN_OUT_FIELD_TYPES.includes(/** @type {string} */ (field.type))) {
    return [
      `fanOut "${fanOut}" must name a config field of type ∈ {${FAN_OUT_FIELD_TYPES.join(', ')}} (got "${field.type}")`,
    ];
  }
  return [];
}

/**
 * Validate the optional `formatting` field. Absence is valid (defaults to
 * `verbatim`); when present it must be one of {@link FORMATTING}.
 *
 * @param {Record<string, unknown>} manifest - the parsed manifest.json
 * @returns {string[]} validation errors (empty when absent or valid)
 */
export function validateFormatting(manifest) {
  const formatting = manifest.formatting;
  if (formatting === undefined) return [];
  if (!FORMATTING.includes(/** @type {string} */ (formatting))) {
    return [`invalid formatting "${formatting}" (allowed: ${FORMATTING.join(', ')})`];
  }
  return [];
}

/**
 * Validate every cross-cutting manifest invariant a source must satisfy: the
 * four type-system fields (held to the MVP cut when implemented), `location`
 * plus its cloud-eligibility predicate, the optional `fanOut` reference, and the
 * optional `formatting` policy.
 *
 * @param {Record<string, unknown>} manifest - the parsed manifest.json
 * @param {{ implemented: boolean }} options - whether the source has code
 * @returns {string[]} validation errors (empty when valid)
 */
export function validateManifest(manifest, { implemented }) {
  return [
    ...validateSourceTypeFields(manifest, { implemented }),
    ...validateLocation(manifest),
    ...validateFanOut(manifest),
    ...validateFormatting(manifest),
  ];
}
