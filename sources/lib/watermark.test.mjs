/**
 * This catalog's proof that `@ontrove/sdk`'s watermark writers behave the way
 * its sources need them to.
 *
 * These do not test catalog code — `watermark.mjs` was a re-export of the SDK's
 * writers under a local specifier, and was deleted so a reader follows one hop
 * instead of two. What the tests pin is the behaviour, not the wrapper.
 *
 * The cloud stores `sources.cursor` as an opaque JSON string; these helpers
 * give every source one tagged shape to read and write, and both catalogs now
 * write the same bytes because both call the same writer.
 *
 * MVP implements three strategies: `date`, `idSet` (bounded), and `none` (no
 * cursor at all — the source returns `undefined`).
 */

import {
  advanceDateWatermark,
  DEFAULT_ID_SET_MAX,
  dateWatermark,
  idSetWatermark,
  readDateWatermark,
  readIdSet,
} from '@ontrove/sdk';
import { describe, expect, it } from 'vitest';
import { dateCursorValue } from './test-fixtures.mjs';

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
  /** @type {import('./types.d.ts').Cursor} */
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
    const advanced = new Date(dateCursorValue(result)).getTime();
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
    expect(result?.type === 'date' && result.inclusive).toBe(true);
  });
});

describe('the cursor byte budget', () => {
  it('keeps the cursor under the platform limit, however many URLs it has seen', () => {
    // The entry cap counts ENTRIES (10,000) while the platform limits BYTES
    // (65,536). A blog URL runs 60–120 bytes, so the count cap alone allows a
    // cursor roughly twelve times over the limit. A scrape source in the
    // private catalog reached it after 571 posts and every run afterwards was
    // refused, leaving it unable to advance past the point where it broke —
    // this helper had the same gap until now, hidden only by the shortness of
    // the one id set this catalog writes today.
    const urls = Array.from(
      { length: 5000 },
      (_, index) => `https://example.com/a-fairly-long-article-slug-${String(index)}`,
    );
    const cursor = idSetWatermark(urls);
    const bytes = new TextEncoder().encode(JSON.stringify(cursor)).length;
    expect(bytes).toBeLessThan(65_536);
    expect(cursor.values.length).toBeLessThan(urls.length);
  });

  it('evicts the OLDEST, since the newest are what a scrape meets next', () => {
    // Evicting is safe — the page is re-scraped once and deduped server-side by
    // external id — but evicting the wrong end would re-scrape the whole front
    // page every run.
    const urls = Array.from(
      { length: 3000 },
      (_, index) => `https://example.com/a-fairly-long-article-slug-number-${String(index)}`,
    );
    const cursor = idSetWatermark(urls);
    expect(cursor.values.at(-1)).toBe(urls.at(-1));
    expect(cursor.values).not.toContain(urls[0]);
  });
});
