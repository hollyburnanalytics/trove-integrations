/**
 * What this catalog needs `@ontrove/extend/source`'s manifest validator to say.
 *
 * The rules used to live in `sources/lib/constants.mjs` as six functions, and
 * this file tested each of them. They are now one call, `validateSourceManifest`,
 * owned by the SDK — so the scenarios survive but the assertions moved onto the
 * one entry point, and onto the SDK's wording rather than the wording the local
 * copy happened to use.
 *
 * The file is kept rather than deleted for the same reason `cursor.test.mjs`
 * is: it is this catalog's proof that the shared validator still refuses what
 * this catalog needs refused. `scripts/validate-registry.mjs` runs the same call
 * over every manifest on disk, so a rule that quietly relaxed would let a broken
 * source into the registry; a failure here is the SDK and this catalog having
 * genuinely diverged.
 */

import type { ManifestValidationOptions } from '@ontrove/extend/source';
import { VALID_SCHEDULES, validateSourceManifest } from '@ontrove/extend/source';
import { describe, expect, it } from 'vitest';

/**
 * A complete, valid, cloud-eligible manifest for a source that has code.
 *
 * Complete on purpose: `validateSourceManifest` checks a whole manifest in one
 * call, so a scenario is expressed by changing ONE field of this and reading
 * back the errors that change with it.
 */
const validManifest = {
  id: 'example-source',
  name: 'Example Source',
  version: '1.0.0',
  kind: 'scheduled-sync',
  transport: 'feed',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'daily',
  needsBrowser: false,
  egress: ['example.com'],
  config: {},
};

/** The options a source that has code is validated under. */
const IMPLEMENTED = { implemented: true };

/** The options a source that is still a stub is validated under. */
const STUB = { implemented: false };

/**
 * The errors from validating `overrides` applied to {@link validManifest}.
 *
 * @param overrides - Fields to replace or add.
 * @param options - Passed through.
 * @returns Every error found.
 */
function errorsFor(
  overrides: Record<string, unknown> = {},
  options: ManifestValidationOptions = IMPLEMENTED,
): string[] {
  return validateSourceManifest({ ...validManifest, ...overrides }, options).errors;
}

/**
 * {@link validManifest} with one declaration removed, for the cases about a
 * manifest that never said something rather than one that said it wrongly.
 *
 * @param field - The declaration to drop.
 * @returns The incomplete manifest.
 */
function without(field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validManifest).filter(([key]) => key !== field));
}

/**
 * Only the errors that are about `field`.
 *
 * One invalid value can legitimately cause errors elsewhere — a bad `transport`
 * also breaks cloud eligibility — so a test about one field counts that field's
 * errors rather than the whole list.
 *
 * @param errors - The full error list.
 * @param field - The manifest field, e.g. `kind`.
 * @returns The errors naming it.
 */
function about(errors: string[], field: string): string[] {
  return errors.filter((error) => error.startsWith(`manifest.${field} `));
}

describe('VALID_SCHEDULES', () => {
  it('exports an array of schedule strings', () => {
    expect(Array.isArray(VALID_SCHEDULES)).toBe(true);
    expect(VALID_SCHEDULES.length).toBeGreaterThan(0);
  });

  it('contains expected schedule values', () => {
    expect(VALID_SCHEDULES).toContain('daily');
    expect(VALID_SCHEDULES).toContain('weekly');
    expect(VALID_SCHEDULES).toContain('monthly');
    expect(VALID_SCHEDULES).toContain('on demand');
    expect(VALID_SCHEDULES).toContain('every 30 minutes');
    expect(VALID_SCHEDULES).toContain('every 1 hour');
  });

  it('contains all interval-based schedules', () => {
    expect(VALID_SCHEDULES).toContain('every 2 hours');
    expect(VALID_SCHEDULES).toContain('every 4 hours');
    expect(VALID_SCHEDULES).toContain('every 6 hours');
    expect(VALID_SCHEDULES).toContain('every 12 hours');
    expect(VALID_SCHEDULES).toContain('yearly');
  });
});

describe('identity and the credential lint', () => {
  it('requires id, name and version', () => {
    const errors = validateSourceManifest({}, STUB).errors;
    expect(errors).toContain('manifest.id is required and must be a non-empty string');
    expect(errors).toContain('manifest.name is required and must be a non-empty string');
    expect(errors).toContain('manifest.version is required and must be a non-empty string');
  });

  it('rejects an id that could not be half of a cloud identity', () => {
    // A source is addressed as `{catalog.id}/{source.id}`, so the id has to
    // survive being written into a path and a filename.
    expect(about(errorsFor({ id: 'Example Source' }), 'id')).toEqual([
      'manifest.id must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)',
    ]);
  });

  it('rejects a credential-shaped config key', () => {
    // Config is user PREFERENCES; auth material is declared separately and read
    // with ctx.secret(). Trove rejects the write server-side, so catching it in
    // the catalog is the difference between a failed build and a failed deploy.
    const errors = errorsFor({ config: { apiKey: { label: 'API key', type: 'text' } } });
    expect(errors.some((error) => error.includes('credential-shaped key(s): apiKey'))).toBe(true);
  });
});

describe('the four type-system fields', () => {
  it('returns no errors for a fully valid MVP manifest (implemented)', () => {
    expect(errorsFor()).toEqual([]);
  });

  it('returns no errors for a fully valid MVP manifest (stub)', () => {
    expect(errorsFor({}, STUB)).toEqual([]);
  });

  it('reports each missing required field', () => {
    const errors = validateSourceManifest({}, STUB).errors;
    for (const field of ['kind', 'transport', 'cursor', 'ingest']) {
      expect(about(errors, field), `nothing said about "${field}"`).toHaveLength(1);
      expect(about(errors, field)[0]).toContain('is required');
    }
  });

  it('reports a single missing field while others are valid', () => {
    const errors = validateSourceManifest(without('transport'), IMPLEMENTED).errors;
    // Missing entirely, so cloud eligibility cannot be satisfied either — one
    // error for the absent declaration, one for the promise it breaks.
    expect(about(errors, 'transport')).toEqual([
      'manifest.transport is required — the transport, one of: feed, scrape, api, browser, local',
    ]);
    expect(about(errors, 'runsIn')).toHaveLength(1);
  });

  it('reports an invalid value that is in no allowed set', () => {
    const errors = about(errorsFor({ transport: 'carrier-pigeon' }, STUB), 'transport');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"carrier-pigeon" is not a known transport');
    expect(errors[0]).toContain('expected one of:');
  });

  it('does not also emit an MVP error when the value is outright invalid', () => {
    // An invalid value short-circuits before the "reserved but not built" check.
    const errors = about(errorsFor({ kind: 'nonsense' }), 'kind');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"nonsense" is not a known execution kind');
  });

  it('allows a deferred (non-MVP) value for a stub source', () => {
    // `on-demand-fetch` is a valid kind but outside the MVP cut; stubs may use
    // it to record the shape they are headed for.
    expect(errorsFor({ kind: 'on-demand-fetch' }, STUB)).toEqual([]);
  });

  it('rejects a deferred (non-MVP) value for an implemented source', () => {
    const errors = about(errorsFor({ kind: 'on-demand-fetch' }), 'kind');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"on-demand-fetch" is a reserved execution kind that nothing runs');
    expect(errors[0]).toContain('must use one of: scheduled-sync');
  });

  it('rejects a non-MVP cursor for an implemented source', () => {
    expect(about(errorsFor({ cursor: 'opaqueToken' }), 'cursor')).toEqual([
      'manifest.cursor "opaqueToken" is a reserved cursor strategy that nothing runs yet; ' +
        `a source with code must use one of: ${['date', 'idSet', 'none'].join(', ')}`,
    ]);
  });

  it('accumulates errors across multiple fields', () => {
    const errors = validateSourceManifest(
      {
        ...without('ingest'),
        kind: 'on-demand-query',
        transport: 'local',
        cursor: 'snapshot',
      },
      IMPLEMENTED,
    ).errors;
    // kind/cursor are valid-but-non-MVP; ingest is missing.
    // transport "local" is in the MVP cut (apple-podcasts), so it passes the
    // cut and fails only the cloud-eligibility predicate.
    expect(about(errors, 'ingest')[0]).toContain('is required');
    expect(about(errors, 'kind')[0]).toContain('reserved execution kind');
    expect(about(errors, 'cursor')[0]).toContain('reserved cursor strategy');
    expect(about(errors, 'transport')).toEqual([]);
  });
});

describe('runsIn and cloud eligibility', () => {
  it('reports a missing runsIn', () => {
    const errors = validateSourceManifest(without('runsIn'), IMPLEMENTED).errors;
    expect(about(errors, 'runsIn')).toHaveLength(1);
    expect(about(errors, 'runsIn')[0]).toContain('is required');
  });

  it('rejects a runsIn outside the enum', () => {
    const errors = about(errorsFor({ runsIn: 'edge' }), 'runsIn');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"edge" is not a known place to run');
    expect(errors[0]).toContain('expected one of: cloud, mac');
  });

  it('accepts a cloud source that satisfies the eligibility predicate', () => {
    expect(errorsFor({ runsIn: 'cloud', transport: 'feed', schedule: 'daily' })).toEqual([]);
  });

  it('accepts cloud for every eligible transport', () => {
    for (const transport of ['feed', 'api', 'scrape']) {
      expect(errorsFor({ runsIn: 'cloud', transport, schedule: 'daily' })).toEqual([]);
    }
  });

  it('rejects a cloud source on a non-eligible transport', () => {
    const errors = about(errorsFor({ transport: 'browser' }), 'runsIn');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"cloud" requires manifest.transport to be one of');
    expect(errors[0]).toContain('got "browser"');
  });

  it('rejects a cloud source that needs a browser', () => {
    const errors = about(errorsFor({ needsBrowser: true }), 'runsIn');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('incompatible with manifest.needsBrowser: true');
  });

  it('rejects a cloud source scheduled on demand', () => {
    const errors = about(errorsFor({ transport: 'api', schedule: 'on demand' }), 'runsIn');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('incompatible with manifest.schedule "on demand"');
  });

  it('accumulates every eligibility violation', () => {
    const errors = errorsFor({
      transport: 'local',
      needsBrowser: true,
      schedule: 'on demand',
    });
    expect(about(errors, 'runsIn')).toHaveLength(3);
  });

  it('imposes no eligibility predicate on a Mac source', () => {
    expect(
      errorsFor({
        runsIn: 'mac',
        transport: 'local',
        needsBrowser: true,
        schedule: 'on demand',
      }),
    ).toEqual([]);
  });
});

describe('fanOut', () => {
  it('accepts a manifest with no fanOut', () => {
    expect(errorsFor({ config: {} })).toEqual([]);
  });

  it('accepts fanOut naming a url[] config field', () => {
    expect(
      errorsFor({ fanOut: 'feeds', config: { feeds: { label: 'Feeds', type: 'url[]' } } }),
    ).toEqual([]);
  });

  it('accepts fanOut naming a text[] config field', () => {
    expect(errorsFor({ fanOut: 'queries', config: { queries: { type: 'text[]' } } })).toEqual([]);
  });

  it('rejects a non-string fanOut', () => {
    const errors = about(errorsFor({ fanOut: ['feeds'], config: {} }), 'fanOut');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('must be a non-empty string naming a field in manifest.config');
  });

  it('rejects fanOut that names no config field', () => {
    expect(about(errorsFor({ fanOut: 'feeds', config: {} }), 'fanOut')).toEqual([
      'manifest.fanOut "feeds" does not name a field in manifest.config',
    ]);
  });

  it('rejects fanOut naming a field of the wrong type', () => {
    const errors = about(
      errorsFor({ fanOut: 'sections', config: { sections: { type: 'array' } } }),
      'fanOut',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('must name a config field whose type is one of');
    expect(errors[0]).toContain('is "array"');
  });
});

describe('formatting', () => {
  it('accepts a manifest with no formatting (defaults to verbatim)', () => {
    expect(errorsFor()).toEqual([]);
  });

  it('accepts formatting: "reformat"', () => {
    expect(errorsFor({ formatting: 'reformat' })).toEqual([]);
  });

  it('accepts formatting: "verbatim"', () => {
    expect(errorsFor({ formatting: 'verbatim' })).toEqual([]);
  });

  it('rejects an unknown formatting value', () => {
    const errors = about(errorsFor({ formatting: 'fancy' }), 'formatting');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"fancy" is not a known formatting policy');
  });
});

/**
 * Stands in for the on-disk provider lookup: only `podcasts` has a module.
 * `scripts/validate-registry.mjs` injects the real one, which checks
 * `sources/lib/directories/`.
 */
const withKnownProviders: ManifestValidationOptions = {
  implemented: true,
  directoryProviderExists: (name) => name === 'podcasts',
};

/**
 * A manifest whose one `url[]` field declares the given directory descriptor.
 *
 * @param directory - The `directory` block under test.
 * @returns The override for {@link errorsFor}.
 */
function withDirectory(directory: unknown): Record<string, unknown> {
  return { config: { feeds: { label: 'Podcast feed URLs', type: 'url[]', directory } } };
}

describe('directory descriptors', () => {
  it('accepts a well-formed directory', () => {
    expect(
      errorsFor(withDirectory({ provider: 'podcasts', mode: 'search' }), withKnownProviders),
    ).toEqual([]);
  });

  it('accepts a manifest with no directory at all', () => {
    expect(errorsFor({ config: { feeds: { type: 'url[]' } } }, withKnownProviders)).toEqual([]);
  });

  it('rejects a provider with no module on disk', () => {
    const errors = errorsFor(
      withDirectory({ provider: 'nope', mode: 'search' }),
      withKnownProviders,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('is not a directory provider this catalog knows');
  });

  it('rejects a mode no client can render', () => {
    const errors = errorsFor(
      withDirectory({ provider: 'podcasts', mode: 'browse' }),
      withKnownProviders,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('directory.mode must be one of');
  });

  it('rejects a non-object directory', () => {
    expect(errorsFor(withDirectory('podcasts'), withKnownProviders)).toEqual([
      'manifest.config.feeds.directory must be an object (got "podcasts")',
    ]);
  });
});

describe('the manifest as a whole', () => {
  it('returns valid: true, not merely an empty error list', () => {
    expect(validateSourceManifest(validManifest, IMPLEMENTED)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('validates the fan-out reference against the config schema', () => {
    expect(errorsFor({ fanOut: 'feeds', config: { feeds: { type: 'url[]' } } })).toEqual([]);
  });

  it('composes type-system, runsIn, and fanOut errors', () => {
    const errors = errorsFor({
      cursor: 'opaqueToken', // reserved, so an error for a source with code
      transport: 'browser', // makes runsIn: cloud ineligible
      fanOut: 'missing', // names no config field
    });
    expect(errors.some((error) => error.includes('reserved cursor strategy'))).toBe(true);
    expect(errors.some((error) => error.includes('"cloud" requires manifest.transport'))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes('manifest.fanOut "missing"'))).toBe(true);
  });

  it('rejects an invalid formatting value alongside the other checks', () => {
    const errors = errorsFor({ formatting: 'fancy', fanOut: 'missing' });
    expect(errors.some((error) => error.includes('not a known formatting policy'))).toBe(true);
    expect(errors.some((error) => error.includes('manifest.fanOut "missing"'))).toBe(true);
  });

  it('accepts a valid formatting value', () => {
    expect(errorsFor({ formatting: 'reformat' })).toEqual([]);
  });
});
