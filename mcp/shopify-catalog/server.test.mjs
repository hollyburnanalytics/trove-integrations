import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** A JSON-RPC success envelope wrapping a UCP structuredContent payload. */
function rpcResult(structuredContent) {
  return { json: { jsonrpc: '2.0', id: 1, result: { structuredContent } } };
}

const SEARCH_CONTENT = {
  ucp: { version: '2026-04-08' },
  products: [
    {
      id: 'gid://shopify/p/abc123',
      title: 'Walnut Desk Organizer',
      description: 'Solid walnut, five compartments.',
      url: 'https://shop.example.com/products/walnut-desk-organizer',
      price_range: {
        min: { amount: 4900, currency: 'CAD' },
        max: { amount: 6900, currency: 'CAD' },
      },
      seller: { name: 'Heartwood Goods', url: 'https://shop.example.com' },
      variants: [{ id: 'v1' }, { id: 'v2' }],
      rating: { value: 4.8, count: 212 },
      media: [{ url: 'https://cdn.example.com/1.jpg' }],
    },
  ],
  pagination: { total_count: 37, next_cursor: 'cur_2' },
};

describe('shopify-catalog MCP server', () => {
  it('search_products wraps the query in a UCP tools/call envelope with the agent profile', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      { query: 'walnut desk organizer', maxPrice: 80 },
      (url, init) => {
        captured = { url, body: JSON.parse(init.body) };
        return rpcResult(SEARCH_CONTENT);
      },
    );
    expect(call.ok).toBe(true);
    const structured = call.result.structured;

    expect(captured.url).toBe('https://catalog.shopify.com/api/ucp/mcp');
    expect(captured.body.method).toBe('tools/call');
    expect(captured.body.params.name).toBe('search_catalog');
    expect(captured.body.params.arguments.meta['ucp-agent'].profile).toContain(
      'trove-integrations/main/mcp/shopify-catalog/ucp-agent-profile.json',
    );
    expect(captured.body.params.arguments.catalog.query).toBe('walnut desk organizer');
    // Major units in, minor units on the wire.
    expect(captured.body.params.arguments.catalog.filters.price.max).toBe(8000);

    expect(structured.count).toBe(1);
    expect(structured.totalEstimate).toBe(37);
    expect(structured.nextCursor).toBe('cur_2');
    const [product] = structured.products;
    expect(product.title).toBe('Walnut Desk Organizer');
    expect(product.priceMin).toBe(49);
    expect(product.priceMax).toBe(69);
    expect(product.currency).toBe('CAD');
    expect(product.seller).toBe('Heartwood Goods');
    expect(product.variantCount).toBe(2);
    expect(product.rating).toBe(4.8);
  });

  it('search_products formats a readable listing and handles empty results', async () => {
    const call = await callTool(server, 'search_products', { query: 'x' }, () =>
      rpcResult({ products: [], pagination: {} }),
    );
    expect(call.ok).toBe(true);
    expect(call.result.text).toContain('No products found');
  });

  it('lookup_products passes ids through and surfaces not_found messages', async () => {
    let captured;
    const call = await callTool(
      server,
      'lookup_products',
      { ids: ['gid://shopify/p/abc123', 'https://shop.example.com/products/gone'] },
      (_url, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({
          products: SEARCH_CONTENT.products,
          messages: [{ code: 'not_found', content: 'https://shop.example.com/products/gone' }],
        });
      },
    );
    expect(call.ok).toBe(true);
    expect(captured.params.name).toBe('lookup_catalog');
    expect(captured.params.arguments.catalog.ids).toHaveLength(2);
    expect(call.result.structured.count).toBe(1);
    expect(call.result.structured.notFound).toEqual(['https://shop.example.com/products/gone']);
  });

  it('get_product narrows by selection and lists variant prices', async () => {
    let captured;
    const call = await callTool(
      server,
      'get_product',
      { id: 'gid://shopify/p/abc123', selected: [{ name: 'Finish', label: 'Natural' }] },
      (_url, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({
          products: [
            {
              ...SEARCH_CONTENT.products[0],
              options: [{ name: 'Finish', values: ['Natural', 'Ebonized'] }],
              variants: [
                { id: 'v1', title: 'Natural', price: { amount: 4900, currency: 'CAD' } },
                { id: 'v2', title: 'Ebonized', price: { amount: 6900, currency: 'CAD' } },
              ],
            },
          ],
        });
      },
    );
    expect(call.ok).toBe(true);
    expect(captured.params.name).toBe('get_product');
    expect(captured.params.arguments.catalog.selected).toEqual([
      { name: 'Finish', label: 'Natural' },
    ]);
    expect(call.result.structured.product.title).toBe('Walnut Desk Organizer');
    expect(call.result.structured.variants).toHaveLength(2);
    expect(call.result.text).toContain('Natural: CAD 49');
  });

  it('maps a UCP JSON-RPC error to a ToolError with the failure code', async () => {
    const call = await callTool(server, 'search_products', { query: 'x' }, () => ({
      json: {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32_001,
          message: 'UCP discovery failed',
          data: { code: 'profile_unreachable', content: 'Unable to fetch agent profile' },
        },
      },
    }));
    expect(call.ok).toBe(false);
    expect(String(call.error?.message ?? call.error)).toMatch(/profile_unreachable/);
  });
});
