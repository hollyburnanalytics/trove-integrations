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
// Connector type system
//
// Four orthogonal manifest fields describe a connector's collection contract:
// `kind` (execution contract), `transport` (mechanism), `watermark` (resume
// strategy), and `documentSemantics` (ingest behavior). Every value is defined
// here so the design is whole and forward-compatible, but only the MVP_* subsets
// are built and enforced today. See docs/connector-taxonomy.md §8 for the full
// formalization and rationale.
// ---------------------------------------------------------------------------

/** Execution contract — which entrypoint the harness invokes. @type {readonly string[]} */
export const CONNECTOR_KINDS = ['scheduled-sync', 'on-demand-fetch', 'on-demand-query'];

/** Mechanism by which a connector reaches its data. @type {readonly string[]} */
export const TRANSPORTS = ['feed', 'scrape', 'api', 'browser', 'local'];

/** Resume strategy declared by a connector; the value lives in `sources.cursor`. @type {readonly string[]} */
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

/** Ingest behavior for a connector's documents. @type {readonly string[]} */
export const DOCUMENT_SEMANTICS = ['append', 'upsert'];

/**
 * The MVP cut: the subset of each type family that the harness and cloud actually
 * build and enforce today. `status: implemented` connectors MUST stay within these;
 * stubs may declare deferred values to encode the roadmap.
 */
export const MVP = {
  kinds: ['scheduled-sync'],
  // `local` graduated from the deferred set with apple-podcasts: the runtime
  // imposes nothing transport-specific, so a connector reading on-disk data
  // needs no harness support beyond what feed/api connectors already use.
  transports: ['feed', 'scrape', 'api', 'browser', 'local'],
  watermarks: ['date', 'idSet', 'none'],
  documentSemantics: ['append'],
};

/** The four type-system fields, with their allowed value sets. @type {Record<string, readonly string[]>} */
export const CONNECTOR_TYPE_FIELDS = {
  kind: CONNECTOR_KINDS,
  transport: TRANSPORTS,
  watermark: WATERMARK_STRATEGIES,
  documentSemantics: DOCUMENT_SEMANTICS,
};

/**
 * Validate a manifest's type-system fields. Returns an array of error strings
 * (empty when valid).
 *
 * @param {Record<string, unknown>} manifest - the parsed manifest.json
 * @param {{ implemented: boolean }} options - whether the connector has code
 *   (implemented connectors are held to the MVP cut; stubs may use deferred values)
 * @returns {string[]} validation errors
 */
export function validateConnectorTypeFields(manifest, { implemented }) {
  const mvpByField = {
    kind: MVP.kinds,
    transport: MVP.transports,
    watermark: MVP.watermarks,
    documentSemantics: MVP.documentSemantics,
  };
  const errors = [];
  for (const [field, allowed] of Object.entries(CONNECTOR_TYPE_FIELDS)) {
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
        `implemented connector uses non-MVP ${field} "${value}" (MVP: ${mvpByField[field].join(', ')})`,
      );
    }
  }
  return errors;
}
