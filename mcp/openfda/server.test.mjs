import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const DRUG_LABELS = {
  results: [
    {
      openfda: {
        brand_name: ['TYLENOL'],
        generic_name: ['ACETAMINOPHEN'],
        manufacturer_name: ['Johnson & Johnson'],
      },
      indications_and_usage: ['  For the temporary relief of minor aches\nand pains. '],
      warnings: ['Liver warning: this product contains acetaminophen.'],
    },
  ],
};

const RECALLS = {
  results: [
    {
      recalling_firm: 'Acme Foods Inc.',
      product_description: 'Frozen spinach, 10oz bags',
      reason_for_recall: 'Potential Listeria monocytogenes contamination',
      classification: 'Class I',
      status: 'Ongoing',
      recall_initiation_date: '20260101',
    },
  ],
};

describe('openfda MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'search_drug_labels',
      'search_recalls',
    ]);
  });

  describe('search_drug_labels', () => {
    it('returns parsed labels for a drug name', async () => {
      const result = await callTool(
        server,
        'search_drug_labels',
        { name: 'Tylenol', limit: 3 },
        { json: DRUG_LABELS },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.query).toBe('Tylenol');
      expect(result.result.structured.count).toBe(1);
      const label = result.result.structured.labels[0];
      expect(label.brandName).toBe('TYLENOL');
      expect(label.genericName).toBe('ACETAMINOPHEN');
      expect(label.manufacturer).toBe('Johnson & Johnson');
      // snippet() collapses whitespace and trims.
      expect(label.indications).toBe('For the temporary relief of minor aches and pains.');
      expect(label.warnings).toContain('Liver warning');
      expect(result.result.text).toContain('TYLENOL');
    });

    it('builds a field-scoped search URL with an encoded term', async () => {
      let requested = '';
      await callTool(server, 'search_drug_labels', { name: 'cold relief', limit: 2 }, (url) => {
        requested = url;
        return { json: DRUG_LABELS };
      });
      expect(requested).toContain('/drug/label.json?search=');
      expect(requested).toContain('openfda.brand_name:%22cold%20relief%22');
      expect(requested).toContain('openfda.generic_name:%22cold%20relief%22');
      expect(requested).toContain('limit=2');
    });

    it('treats a 404 as zero matches, not an error', async () => {
      const result = await callTool(
        server,
        'search_drug_labels',
        { name: 'nonexistentdrug' },
        { status: 404 },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.labels).toEqual([]);
      expect(result.result.text).toMatch(/no fda drug labels/i);
    });

    it('maps a 429 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_drug_labels',
        { name: 'Tylenol' },
        { status: 429 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate limit/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_drug_labels',
        { name: 'Tylenol' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/unavailable/i);
    });

    it('rejects limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_drug_labels', { name: 'Tylenol', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty name before fetching', async () => {
      const result = await callTool(server, 'search_drug_labels', { name: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('search_recalls', () => {
    it('returns parsed recalls for a category and query', async () => {
      const result = await callTool(
        server,
        'search_recalls',
        { category: 'food', query: 'listeria', limit: 5 },
        { json: RECALLS },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.category).toBe('food');
      expect(result.result.structured.query).toBe('listeria');
      expect(result.result.structured.count).toBe(1);
      const recall = result.result.structured.recalls[0];
      expect(recall.firm).toBe('Acme Foods Inc.');
      expect(recall.product).toBe('Frozen spinach, 10oz bags');
      expect(recall.reason).toContain('Listeria');
      expect(recall.classification).toBe('Class I');
      expect(recall.status).toBe('Ongoing');
      expect(recall.date).toBe('20260101');
      expect(result.result.text).toContain('Acme Foods Inc.');
    });

    it('routes the request to the category-specific enforcement endpoint', async () => {
      let requested = '';
      await callTool(server, 'search_recalls', { category: 'device', query: 'pump' }, (url) => {
        requested = url;
        return { json: RECALLS };
      });
      expect(requested).toContain('/device/enforcement.json?search=');
      expect(requested).toContain('reason_for_recall:%22pump%22');
      expect(requested).toContain('recalling_firm:%22pump%22');
    });

    it('treats a 404 as zero matches', async () => {
      const result = await callTool(
        server,
        'search_recalls',
        { category: 'drug', query: 'nothing' },
        { status: 404 },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.recalls).toEqual([]);
      expect(result.result.text).toMatch(/no drug recalls/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_recalls',
        { category: 'food', query: 'listeria' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an unknown category before fetching', async () => {
      const result = await callTool(server, 'search_recalls', { category: 'cosmetic', query: 'x' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_recalls', {
        category: 'food',
        query: 'listeria',
        limit: 99,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
