import { describe, expect, it } from 'bun:test';
import { VALID_SCHEDULES, validateSourceTypeFields } from './constants.mjs';

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

describe('validateSourceTypeFields', () => {
  /** A manifest that satisfies the MVP cut on every type-system field. */
  const validMvpManifest = {
    kind: 'scheduled-sync',
    transport: 'scrape',
    watermark: 'date',
    documentSemantics: 'append',
  };

  it('returns no errors for a fully valid MVP manifest (implemented)', () => {
    expect(validateSourceTypeFields(validMvpManifest, { implemented: true })).toEqual([]);
  });

  it('returns no errors for a fully valid MVP manifest (stub)', () => {
    expect(validateSourceTypeFields(validMvpManifest, { implemented: false })).toEqual([]);
  });

  it('reports each missing required field', () => {
    const errors = validateSourceTypeFields({}, { implemented: false });
    expect(errors).toHaveLength(4);
    expect(errors).toContain('missing required field "kind"');
    expect(errors).toContain('missing required field "transport"');
    expect(errors).toContain('missing required field "watermark"');
    expect(errors).toContain('missing required field "documentSemantics"');
  });

  it('reports a single missing field while others are valid', () => {
    const withoutTransport = Object.fromEntries(
      Object.entries(validMvpManifest).filter(([key]) => key !== 'transport'),
    );
    const errors = validateSourceTypeFields(withoutTransport, { implemented: true });
    expect(errors).toEqual(['missing required field "transport"']);
  });

  it('reports an invalid value that is in no allowed set', () => {
    const errors = validateSourceTypeFields(
      { ...validMvpManifest, transport: 'carrier-pigeon' },
      { implemented: false },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid transport "carrier-pigeon"');
    expect(errors[0]).toContain('allowed:');
  });

  it('does not also emit an MVP error when the value is outright invalid', () => {
    // An invalid value short-circuits (continue) before the MVP check runs.
    const errors = validateSourceTypeFields(
      { ...validMvpManifest, kind: 'nonsense' },
      { implemented: true },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid kind "nonsense"');
  });

  it('allows a deferred (non-MVP) value for a stub source', () => {
    // `on-demand-fetch` is a valid kind but outside the MVP cut; stubs may use it.
    const errors = validateSourceTypeFields(
      { ...validMvpManifest, kind: 'on-demand-fetch' },
      { implemented: false },
    );
    expect(errors).toEqual([]);
  });

  it('rejects a deferred (non-MVP) value for an implemented source', () => {
    const errors = validateSourceTypeFields(
      { ...validMvpManifest, kind: 'on-demand-fetch' },
      { implemented: true },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('implemented source uses non-MVP kind "on-demand-fetch"');
    expect(errors[0]).toContain('MVP:');
  });

  it('rejects a non-MVP watermark for an implemented source', () => {
    const errors = validateSourceTypeFields(
      { ...validMvpManifest, watermark: 'opaqueToken' },
      { implemented: true },
    );
    expect(errors).toEqual([
      `implemented source uses non-MVP watermark "opaqueToken" (MVP: ${[
        'date',
        'idSet',
        'none',
      ].join(', ')})`,
    ]);
  });

  it('accumulates errors across multiple fields', () => {
    const errors = validateSourceTypeFields(
      { kind: 'on-demand-query', transport: 'local', watermark: 'snapshot' },
      { implemented: true },
    );
    // kind/watermark are valid-but-non-MVP; documentSemantics is missing.
    // transport "local" is in the MVP cut (apple-podcasts), so it passes.
    expect(errors).toHaveLength(3);
    expect(errors).toContain('missing required field "documentSemantics"');
    expect(errors.some((error) => error.includes('non-MVP kind "on-demand-query"'))).toBe(true);
    expect(errors.some((error) => error.includes('non-MVP watermark "snapshot"'))).toBe(true);
  });
});
