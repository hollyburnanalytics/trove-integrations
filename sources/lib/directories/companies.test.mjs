import { describe, expect, it } from 'vitest';
import { makeDirectoryContext } from '../test-fixtures.mjs';
import { matchRank, parseRegistry, query } from './companies.mjs';

/** EDGAR's registry shape: an object keyed by row number, not an array. */
const REGISTRY = {
  0: { cik_str: 1_045_810, ticker: 'NVDA', title: 'NVIDIA CORP' },
  1: { cik_str: 320_193, ticker: 'AAPL', title: 'Apple Inc.' },
  2: { cik_str: 1_594_805, ticker: 'SHOP', title: 'Shopify Inc.' },
  3: { cik_str: 1_000_000, ticker: 'SHOO', title: 'Steven Madden, Ltd.' },
  4: { cik_str: 1_000_001, ticker: 'WSM', title: 'Williams-Sonoma, Inc.' },
};

/**
 * A directory context whose fetch returns a canned JSON payload.
 *
 * @param {unknown} payload - What `.json()` resolves to.
 * @param {number} [status] - The status code; `ok` follows from it, as it does
 *   on a real Response — there is no such thing as a 404 that succeeded.
 * @returns {ReturnType<typeof makeDirectoryContext>} The context.
 */
function contextReturning(payload, status = 200) {
  return makeDirectoryContext({ ok: status < 400, status, json: async () => payload });
}

describe('parseRegistry', () => {
  it('reads EDGAR’s row-keyed object', () => {
    expect(parseRegistry(REGISTRY)).toHaveLength(5);
    expect(parseRegistry(REGISTRY)[1]).toEqual({ ticker: 'AAPL', name: 'Apple Inc.' });
  });

  it('drops rows it cannot use, and survives junk', () => {
    expect(parseRegistry({ 0: { ticker: '', title: 'No symbol' }, 1: { ticker: 'X' } })).toEqual(
      [],
    );
    expect(parseRegistry()).toEqual([]);
    expect(parseRegistry('nope')).toEqual([]);
  });
});

describe('matchRank', () => {
  const shop = { ticker: 'SHOP', name: 'Shopify Inc.' };

  it('ranks an exact symbol above everything', () => {
    expect(matchRank(shop, 'shop')).toBeLessThan(matchRank({ ...shop, ticker: 'SHOPX' }, 'shop'));
  });

  it('ranks a symbol prefix above a name match', () => {
    expect(matchRank({ ticker: 'SHOO', name: 'Steven Madden, Ltd.' }, 'sho')).toBeLessThan(
      matchRank({ ticker: 'WSM', name: 'Williams-Sonoma, Inc.' }, 'sho'),
    );
  });

  it('reports no match as infinite', () => {
    expect(matchRank(shop, 'zzz')).toBe(Infinity);
  });
});

describe('companies directory', () => {
  it('finds a company by name and returns its ticker as the value', async () => {
    // The whole point: people know "Shopify", not that it files as SHOP.
    const entries = await query({ query: 'shopify', limit: 10 }, contextReturning(REGISTRY));
    expect(entries[0]).toEqual({ value: 'SHOP', title: 'Shopify Inc.', subtitle: 'SHOP' });
  });

  it('puts the exact symbol first when the term IS a symbol', async () => {
    // Searching "shop" must not bury SHOP under every company named "Shop…".
    const entries = await query({ query: 'shop', limit: 10 }, contextReturning(REGISTRY));
    expect(entries[0]?.value).toBe('SHOP');
  });

  it('returns nothing for an empty query rather than ten thousand companies', async () => {
    const context = contextReturning(REGISTRY);
    await expect(query({ limit: 10 }, context)).resolves.toEqual([]);
    // And costs no fetch: the registry is ~800 KB.
    expect(context.fetch).not.toHaveBeenCalled();
  });

  it('returns nothing when no company matches', async () => {
    await expect(query({ query: 'zzzzz', limit: 10 }, contextReturning(REGISTRY))).resolves.toEqual(
      [],
    );
  });

  it('honours the limit', async () => {
    const entries = await query({ query: 'inc', limit: 2 }, contextReturning(REGISTRY));
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it('reports an unreachable registry rather than no companies', async () => {
    const context = contextReturning({}, 403);
    await expect(query({ query: 'apple', limit: 5 }, context)).rejects.toThrow(/403/);
  });
});
