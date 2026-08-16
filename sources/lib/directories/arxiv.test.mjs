import { describe, expect, it, vi } from 'vitest';
import { parseCategories, query, specToCategory } from './arxiv.mjs';

/** A ListSets response containing the given `[spec, name]` pairs. */
function listSets(...pairs) {
  const sets = pairs
    .map(
      ([spec, name]) => `<set>\n  <setSpec>${spec}</setSpec>\n  <setName>${name}</setName>\n</set>`,
    )
    .join('\n');
  return `<?xml version="1.0"?><OAI-PMH><ListSets>${sets}</ListSets></OAI-PMH>`;
}

function contextReturning(body, ok = true, status = 200) {
  return {
    fetch: vi.fn(async () => ({ ok, status, text: async () => body })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('specToCategory', () => {
  it('maps a nested set to the category arXiv search wants', () => {
    expect(specToCategory('cs:cs:AI')).toBe('cs.AI');
    expect(specToCategory('math:math:AC')).toBe('math.AC');
    expect(specToCategory('physics:astro-ph:CO')).toBe('astro-ph.CO');
    expect(specToCategory('q-bio:q-bio:BM')).toBe('q-bio.BM');
  });

  it('keeps a legacy archive that never gained sub-categories', () => {
    expect(specToCategory('physics:hep-th')).toBe('hep-th');
    expect(specToCategory('physics:gr-qc')).toBe('gr-qc');
  });

  it('skips a bare archive, which is not a category', () => {
    // `cat:cs` matches no papers. Offering it would be a query that quietly
    // returns nothing — worse than not offering it.
    expect(specToCategory('cs')).toBeUndefined();
    expect(specToCategory('math:math')).toBeUndefined();
  });
});

describe('parseCategories', () => {
  it('reads the archive’s own list', () => {
    const xml = listSets(['cs:cs:AI', 'Artificial Intelligence'], ['cs:cs:LG', 'Machine Learning']);
    expect(parseCategories(xml)).toEqual([
      { category: 'cs.AI', name: 'Artificial Intelligence' },
      { category: 'cs.LG', name: 'Machine Learning' },
    ]);
  });

  it('de-duplicates categories reachable by more than one set', () => {
    const xml = listSets(
      ['cs:cs:AI', 'Artificial Intelligence'],
      ['cs:cs:AI', 'Artificial Intelligence'],
    );
    expect(parseCategories(xml)).toHaveLength(1);
  });

  it('returns nothing for a response carrying no sets', () => {
    expect(parseCategories('<OAI-PMH></OAI-PMH>')).toEqual([]);
  });
});

describe('arxiv directory', () => {
  const XML = listSets(
    ['cs:cs:AI', 'Artificial Intelligence'],
    ['cs:cs:LG', 'Machine Learning'],
    ['physics:astro-ph:CO', 'Cosmology and Nongalactic Astrophysics'],
  );

  it('offers the taxonomy itself when nothing is typed', async () => {
    // Unlike a podcast index, this IS a list, and short enough to browse.
    const entries = await query({ limit: 50 }, contextReturning(XML));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      value: 'cat:cs.AI',
      title: 'Artificial Intelligence',
      subtitle: 'cs.AI',
    });
  });

  it('matches on the subject name, which is what people know', async () => {
    const entries = await query({ query: 'machine learning', limit: 50 }, contextReturning(XML));
    expect(entries.map((entry) => entry.value)).toEqual(['cat:cs.LG']);
  });

  it('matches on the category code too', async () => {
    const entries = await query({ query: 'astro-ph', limit: 50 }, contextReturning(XML));
    expect(entries.map((entry) => entry.value)).toEqual(['cat:astro-ph.CO']);
  });

  it('emits a whole arXiv query, since that is what the field holds', async () => {
    const entries = await query({ query: 'cs.AI', limit: 5 }, contextReturning(XML));
    expect(entries[0]?.value).toBe('cat:cs.AI');
  });

  it('honours the limit', async () => {
    expect(await query({ limit: 2 }, contextReturning(XML))).toHaveLength(2);
  });

  it('reports an unreachable archive rather than an empty taxonomy', async () => {
    // "arXiv is down" and "arXiv has no such subject" are different claims.
    const context = contextReturning('', false, 503);
    await expect(query({ query: 'cs', limit: 5 }, context)).rejects.toThrow(/503/);
  });
});
