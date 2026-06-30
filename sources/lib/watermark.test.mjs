import { describe, expect, it } from 'bun:test';
import {
  advanceDateWatermark,
  DEFAULT_ID_SET_MAX,
  dateWatermark,
  idSetWatermark,
  readDateWatermark,
  readIdSet,
} from './watermark.mjs';

describe('date watermark', () => {
  it('reads the typed shape', () => {
    expect(readDateWatermark({ type: 'date', value: '2024-01-10T00:00:00.000Z' })).toEqual(
      new Date('2024-01-10T00:00:00.000Z'),
    );
  });

  it('returns undefined for an absent, empty, or unparseable cursor', () => {
    expect(readDateWatermark()).toBeUndefined();
    expect(readDateWatermark({})).toBeUndefined();
    expect(readDateWatermark({ type: 'date', value: 'not-a-date' })).toBeUndefined();
  });

  it('builds the typed shape', () => {
    expect(dateWatermark('2024-01-10T00:00:00.000Z')).toEqual({
      type: 'date',
      value: '2024-01-10T00:00:00.000Z',
    });
  });
});

describe('idSet watermark', () => {
  it('reads the typed shape', () => {
    expect(readIdSet({ type: 'idSet', values: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('returns an empty array for an absent cursor', () => {
    expect(readIdSet()).toEqual([]);
    expect(readIdSet({})).toEqual([]);
  });

  it('builds a deduped, tagged shape with the default cap', () => {
    expect(idSetWatermark(['a', 'b', 'a'])).toEqual({
      type: 'idSet',
      values: ['a', 'b'],
      max: DEFAULT_ID_SET_MAX,
    });
  });

  it('bounds the set to `max`, keeping the newest entries', () => {
    const values = Array.from({ length: 12 }, (_, index) => `id-${index}`);
    const result = idSetWatermark(values, 10);
    expect(result.values).toHaveLength(10);
    expect(result.max).toBe(10);
    expect(result.values.at(0)).toBe('id-2'); // oldest two evicted
    expect(result.values.at(-1)).toBe('id-11'); // newest kept
  });
});

describe('advanceDateWatermark', () => {
  const previous = { type: 'date', value: '2026-01-01T00:00:00.000Z' };

  it('advances to the max date when every sub-source succeeded', () => {
    expect(
      advanceDateWatermark({ previous, maxIso: '2026-02-01T00:00:00.000Z', anyFailed: false }),
    ).toEqual({ type: 'date', value: '2026-02-01T00:00:00.000Z' });
  });

  it('holds the previous cursor when any sub-source failed', () => {
    // Advancing on the healthy sub-sources' dates would permanently skip the
    // failed sub-source's older items; the next run re-fetches the window and
    // the server dedups what was already stored.
    expect(
      advanceDateWatermark({ previous, maxIso: '2026-02-01T00:00:00.000Z', anyFailed: true }),
    ).toBe(previous);
  });

  it('holds the previous cursor when there is nothing to advance to', () => {
    expect(advanceDateWatermark({ previous, maxIso: undefined, anyFailed: false })).toBe(previous);
  });

  it('clamps a future max date to now (scheduled items)', () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const before = Date.now();
    const result = advanceDateWatermark({ previous, maxIso: future, anyFailed: false });
    const advanced = new Date(result.value).getTime();
    expect(advanced).toBeGreaterThanOrEqual(before - 1000);
    expect(advanced).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('passes the inclusive flag through', () => {
    const result = advanceDateWatermark({
      previous,
      maxIso: '2026-02-01T00:00:00.000Z',
      anyFailed: false,
      inclusive: true,
    });
    expect(result.inclusive).toBe(true);
  });
});
