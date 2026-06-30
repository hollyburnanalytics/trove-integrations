import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/**
 * eBay's Browse API is reached behind OAuth2 client-credentials, so the SDK
 * issues two side requests before any handler fetch: it resolves the configured
 * secrets via the `/internal/secret` callback, then POSTs the token endpoint to
 * mint a Bearer. `upstream` satisfies both deterministically and delegates the
 * real `…/buy/browse/…` call to the provided spec/fn.
 */
function upstream(apiResponder) {
  return (url, init) => {
    if (url.includes('/internal/secret')) return { json: { value: 'test-client' } };
    if (url.includes('/identity/v1/oauth2/token')) {
      return { json: { access_token: 'test-token', expires_in: 7200 } };
    }
    return typeof apiResponder === 'function' ? apiResponder(url, init) : apiResponder;
  };
}

const SEARCH_BODY = {
  total: 2,
  itemSummaries: [
    {
      itemId: 'v1|111|0',
      title: 'Fender Stratocaster American Professional II',
      price: { value: '899.99', currency: 'USD' },
      condition: 'Used',
      buyingOptions: ['FIXED_PRICE'],
      seller: { username: 'guitarguy', feedbackPercentage: '99.5' },
      shippingOptions: [{ shippingCost: { value: '25.00', currency: 'USD' } }],
      itemLocation: { country: 'US' },
      image: { imageUrl: 'https://img.ebay.com/1.jpg' },
      itemWebUrl: 'https://www.ebay.com/itm/111',
    },
    {
      itemId: 'v1|222|0',
      title: 'Fender Stratocaster Mexican',
      price: { value: '650.00', currency: 'USD' },
      condition: 'New',
      buyingOptions: ['AUCTION'],
      seller: { username: 'musicshop', feedbackPercentage: '100.0' },
      shippingOptions: [{ shippingCost: { value: '0.00', currency: 'USD' } }],
      itemLocation: { country: 'US' },
      image: { imageUrl: 'https://img.ebay.com/2.jpg' },
      itemWebUrl: 'https://www.ebay.com/itm/222',
    },
  ],
};

const ITEM_BODY = {
  itemId: 'v1|256|0',
  title: 'Canon AE-1 35mm Film Camera',
  price: { value: '150.00', currency: 'USD' },
  condition: 'Used',
  shortDescription: 'A classic SLR in good working order.',
  localizedAspects: [
    { name: 'Brand', value: 'Canon' },
    { name: 'Model', value: 'AE-1' },
    { name: 'Type', value: 'SLR' },
  ],
  seller: { username: 'camstore', feedbackPercentage: '98.0' },
  shippingOptions: [{ shippingCost: { value: '10.00', currency: 'USD' } }],
  returnTerms: { returnsAccepted: true },
  itemLocation: { country: 'US' },
  image: { imageUrl: 'https://img.ebay.com/cam.jpg' },
  itemWebUrl: 'https://www.ebay.com/itm/256',
};

describe('ebay MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_item', 'search_items']);
  });

  describe('search_items', () => {
    it('returns mapped listings with price, seller, and shipping', async () => {
      const result = await callTool(
        server,
        'search_items',
        { query: 'Fender Stratocaster' },
        upstream({ json: SEARCH_BODY }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.total).toBe(2);
      expect(s.count).toBe(2);
      expect(s.items).toHaveLength(2);

      const first = s.items[0];
      expect(first.itemId).toBe('v1|111|0');
      expect(first.title).toBe('Fender Stratocaster American Professional II');
      expect(first.price).toBe(899.99);
      expect(first.currency).toBe('USD');
      expect(first.condition).toBe('Used');
      expect(first.buyingOptions).toEqual(['FIXED_PRICE']);
      expect(first.seller).toBe('guitarguy');
      expect(first.sellerFeedbackPct).toBe('99.5');
      expect(first.shippingCost).toBe(25);
      expect(first.location).toBe('US');
      expect(first.imageUrl).toBe('https://img.ebay.com/1.jpg');
      expect(first.url).toBe('https://www.ebay.com/itm/111');

      expect(result.result.text).toContain('Fender Stratocaster American Professional II');
      expect(result.result.text).toContain('EBAY_US');
    });

    it('encodes price, condition, and buying-option filters plus sort into the request', async () => {
      let requested = '';
      await callTool(
        server,
        'search_items',
        {
          query: 'vintage guitar',
          minPrice: 100,
          maxPrice: 500,
          condition: 'USED',
          buyingOption: 'FIXED_PRICE',
          marketplace: 'EBAY_CA',
          sort: 'price_low',
          limit: 5,
        },
        upstream((url) => {
          if (url.includes('/item_summary/search')) requested = url;
          return { json: SEARCH_BODY };
        }),
      );
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/buy/browse/v1/item_summary/search');
      expect(decoded).toContain('q=vintage+guitar');
      expect(decoded).toContain('limit=5');
      expect(decoded).toContain('price:[100..500]');
      expect(decoded).toContain('priceCurrency:CAD');
      expect(decoded).toContain('conditions:{USED}');
      expect(decoded).toContain('buyingOptions:{FIXED_PRICE}');
      expect(decoded).toContain('sort=price');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_items',
        { query: 'nonexistent thing' },
        upstream({ json: { total: 0, itemSummaries: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.total).toBe(0);
      expect(result.result.text).toMatch(/no ebay listings/i);
    });

    it('maps a 400 to a non-retryable error carrying eBay’s reason', async () => {
      const result = await callTool(
        server,
        'search_items',
        { query: 'x' },
        upstream({ status: 400, json: { errors: [{ message: 'Invalid filter syntax' }] } }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/Invalid filter syntax/);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'search_items',
        { query: 'x' },
        upstream({ status: 500 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an out-of-range limit before fetching', async () => {
      const result = await callTool(server, 'search_items', { query: 'x', limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_items', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_item', () => {
    it('returns full detail for one listing', async () => {
      const result = await callTool(
        server,
        'get_item',
        { itemId: 'v1|256|0' },
        upstream({ json: ITEM_BODY }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.itemId).toBe('v1|256|0');
      expect(s.title).toBe('Canon AE-1 35mm Film Camera');
      expect(s.price).toBe(150);
      expect(s.currency).toBe('USD');
      expect(s.condition).toBe('Used');
      expect(s.shortDescription).toBe('A classic SLR in good working order.');
      expect(s.aspects).toEqual([
        { name: 'Brand', value: 'Canon' },
        { name: 'Model', value: 'AE-1' },
        { name: 'Type', value: 'SLR' },
      ]);
      expect(s.seller).toBe('camstore');
      expect(s.sellerFeedbackPct).toBe('98.0');
      expect(s.shippingCost).toBe(10);
      expect(s.returnsAccepted).toBe(true);
      expect(s.location).toBe('US');
      expect(s.imageUrl).toBe('https://img.ebay.com/cam.jpg');
      expect(s.url).toBe('https://www.ebay.com/itm/256');

      expect(result.result.text).toContain('Canon AE-1 35mm Film Camera');
      expect(result.result.text).toContain('Brand: Canon');
    });

    it('encodes the itemId into the request path', async () => {
      let requested = '';
      await callTool(
        server,
        'get_item',
        { itemId: 'v1|256|0' },
        upstream((url) => {
          if (url.includes('/buy/browse/v1/item/')) requested = url;
          return { json: ITEM_BODY };
        }),
      );
      expect(requested).toContain('/buy/browse/v1/item/v1%7C256%7C0');
    });

    it('maps a 404 to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'get_item',
        { itemId: 'v1|000|0' },
        upstream({ status: 404 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('maps a 503 to a retryable error', async () => {
      const result = await callTool(
        server,
        'get_item',
        { itemId: 'v1|256|0' },
        upstream({ status: 503 }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a too-short itemId before fetching', async () => {
      const result = await callTool(server, 'get_item', { itemId: 'ab' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
