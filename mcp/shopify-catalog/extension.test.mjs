import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool } from '../lib/test-harness.mjs';
import server from './extension.ts';

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
      description: { plain: 'Solid walnut, five compartments.' },
      price_range: {
        min: { amount: 4900, currency: 'CAD' },
        max: { amount: 6900, currency: 'CAD' },
      },
      variants: [
        {
          id: 'v1',
          url: 'https://www.heartwoodgoods.com/products/walnut-desk-organizer?variant=1&_gsid=track123',
          availability: { available: true },
        },
        { id: 'v2', availability: { available: false } },
      ],
      rating: { value: 4.8, count: 212 },
      media: [{ type: 'image', url: 'https://cdn.example.com/1.jpg' }],
    },
  ],
  pagination: { total_count: 37, has_next_page: true, cursor: 'cur_2' },
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
      'trove-integrations@main/mcp/shopify-catalog/ucp-agent-profile.json',
    );
    expect(captured.body.params.arguments.catalog.query).toBe('walnut desk organizer');
    expect(captured.body.params.arguments.catalog.view).toBe('offer');
    // Major units in, minor units on the wire. The band is evaluated on a USD
    // basis upstream regardless of any currency we send, so we send none.
    expect(captured.body.params.arguments.catalog.filters.price.max).toBe(8000);
    expect(captured.body.params.arguments.catalog.filters.price).not.toHaveProperty('currency');

    expect(structured.count).toBe(1);
    expect(structured.totalEstimate).toBe(37);
    expect(structured.nextCursor).toBe('cur_2');
    // has_next_page=false must null the cursor even when one is present.
    const [product] = structured.products;
    expect(product.title).toBe('Walnut Desk Organizer');
    expect(product.description).toBe('Solid walnut, five compartments.');
    expect(product.priceMin).toBe(49);
    expect(product.priceMax).toBe(69);
    expect(product.currency).toBe('CAD');
    // URL from the first variant, tracking params stripped, variant kept.
    expect(product.url).toBe(
      'https://www.heartwoodgoods.com/products/walnut-desk-organizer?variant=1',
    );
    expect(product.store).toBe('heartwoodgoods.com');
    expect(product.storeUrl).toBe('https://heartwoodgoods.com');
    expect(product.available).toBe(true);
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

  it('normalizes empty descriptions to null and falls back to variant media for images', async () => {
    const call = await callTool(server, 'search_products', { query: 'x' }, () =>
      rpcResult({
        products: [
          {
            id: 'gid://shopify/p/x1',
            title: 'Sparse Product',
            description: { plain: '' },
            price_range: {
              min: { amount: 100, currency: 'USD' },
              max: { amount: 100, currency: 'USD' },
            },
            variants: [
              {
                id: 'v1',
                url: 'https://shop.example.com/products/sparse',
                availability: { available: true },
                media: [{ type: 'image', url: 'https://cdn.example.com/variant.jpg' }],
              },
            ],
          },
        ],
        pagination: {},
      }),
    );
    expect(call.ok).toBe(true);
    const [product] = call.result.structured.products;
    expect(product.description).toBeNull();
    expect(product.imageUrl).toBe('https://cdn.example.com/variant.jpg');
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
          product: {
            ...SEARCH_CONTENT.products[0],
            options: [{ name: 'Finish', values: ['Natural', 'Ebonized'] }],
            variants: [
              { id: 'v1', title: 'Natural', price: { amount: 4900, currency: 'CAD' } },
              { id: 'v2', title: 'Ebonized', price: { amount: 6900, currency: 'CAD' } },
            ],
          },
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

  it('similar-item and visual search populate the like array; bare filter-only calls are rejected', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      {
        similarTo: 'gid://shopify/p/abc123',
        image: { contentType: 'image/jpeg', data: 'aGVsbG8=' },
        minRating: 4,
      },
      (_url, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    // Upstream `like` items are a strict oneOf: a `gid://shopify/...` id, or an
    // inline base64 image object. A bare image URL string is rejected upstream.
    expect(captured.params.arguments.catalog.like).toEqual([
      { id: 'gid://shopify/p/abc123' },
      { image: { content_type: 'image/jpeg', data: 'aGVsbG8=' } },
    ]);
    // Ratings filter on the variant leg: `{ variant: { min, min_count } }`.
    expect(captured.params.arguments.catalog.filters.rating).toEqual({ variant: { min: 4 } });
    expect(captured.params.arguments.catalog.query).toBeUndefined();

    const bare = await callTool(server, 'search_products', {}, () =>
      rpcResult({ products: [], pagination: {} }),
    );
    expect(bare.ok).toBe(false);
    expect(String(bare.error?.message ?? bare.error)).toMatch(/query, a similarTo/);
  });

  it('carries minRatingCount onto the variant rating filter', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      { query: 'coffee grinder', minRating: 4.5, minRatingCount: 25 },
      (_url, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    expect(captured.params.arguments.catalog.filters.rating).toEqual({
      variant: { min: 4.5, min_count: 25 },
    });
  });

  it('scales the price band by the context currency ISO exponent, not a flat 100', async () => {
    let captured;
    // The band is denominated in the context currency's minor units, and the
    // yen has none — a flat *100 would send ¥800,000 for a ¥8,000 ceiling.
    const call = await callTool(
      server,
      'search_products',
      { query: 'kotatsu', maxPrice: 8000, minPrice: 1000, context: { currency: 'jpy' } },
      (_u, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    expect(captured.params.arguments.catalog.filters.price).toEqual({ min: 1000, max: 8000 });
    // ISO codes travel in the uppercase form the schema declares.
    expect(captured.params.arguments.catalog.context).toEqual({ currency: 'JPY' });
  });

  it('rejects a similarTo id that is not a Shopify GID before spending a request', async () => {
    const call = await callTool(server, 'search_products', { similarTo: 'abc123' }, () => {
      throw new Error('must not reach the network');
    });
    expect(call.ok).toBe(false);
    expect(String(call.error?.message ?? call.error)).toMatch(/gid:\/\/shopify\//);
  });

  it('sends documented filter shapes: condition array, available boolean, ships_to object', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      { query: 'vintage chair', condition: 'secondhand', includeUnavailable: true, shipsTo: 'CA' },
      (_url, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    const filters = captured.params.arguments.catalog.filters;
    expect(filters.condition).toEqual(['secondhand']);
    expect(filters.available).toBe(false);
    expect(filters.ships_to).toEqual({ country: 'CA' });
  });

  it('sends attributes, price tier and shipping origin in their wire shapes', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      {
        query: 'running shorts',
        attributes: [{ name: 'Color', values: ['Red', 'Blue'] }],
        priceTier: ['low', 'medium'],
        shipsFrom: ['ca', 'US'],
      },
      (_u, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    const filters = captured.params.arguments.catalog.filters;
    expect(filters.attributes).toEqual([{ name: 'Color', values: ['Red', 'Blue'] }]);
    // A flat array of strings — OR logic, unlike ships_from's array of objects.
    expect(filters.price_tier).toEqual(['low', 'medium']);
    expect(filters.ships_from).toEqual([{ country: 'CA' }, { country: 'US' }]);
  });

  it('omits the new filters entirely when the caller passes empty arrays', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      { query: 'x', attributes: [], priceTier: [], shipsFrom: [] },
      (_u, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    // An empty `categories: []` still returns results upstream while any value
    // returns none — an empty filter must never reach the wire as a narrowing.
    expect(captured.params.arguments.catalog).not.toHaveProperty('filters');
  });

  it('surfaces the advisory when upstream ignores an unsupported attribute name', async () => {
    const call = await callTool(
      server,
      'search_products',
      { query: 'tee', attributes: [{ name: 'Flavour', values: ['Red'] }] },
      () =>
        rpcResult({
          products: [],
          messages: [
            {
              type: 'info',
              code: 'not_found',
              path: '$.filters.attributes[0]',
              content: 'Attribute "Flavour" is not supported and was ignored.',
            },
          ],
          pagination: {},
        }),
    );
    expect(call.ok).toBe(true);
    // Upstream reports an ignored filter as `not_found`, which the lookup path
    // reads as a missing id. On a search there are no ids — it is an advisory,
    // and silently dropping it leaves the caller believing the filter applied.
    expect(call.result.structured.notes).toEqual([
      'not_found: Attribute "Flavour" is not supported and was ignored.',
    ]);
  });

  it('sends shop and taxonomy-category filters as GID arrays', async () => {
    let captured;
    const call = await callTool(
      server,
      'search_products',
      {
        query: 'organizer',
        shops: ['gid://shopify/Shop/71786430654'],
        categories: ['gid://shopify/TaxonomyCategory/hg'],
      },
      (_u, init) => {
        captured = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(call.ok).toBe(true);
    const filters = captured.params.arguments.catalog.filters;
    expect(filters.shops).toEqual(['gid://shopify/Shop/71786430654']);
    expect(filters.categories).toEqual(['gid://shopify/TaxonomyCategory/hg']);
  });

  it('rejects shop and category ids that are not GIDs, before spending a request', async () => {
    const boom = () => {
      throw new Error('must not reach the network');
    };
    // Upstream answers an unrecognized GID with zero results and no message,
    // which is indistinguishable from a shop that stocks nothing. Catching the
    // shape here turns a silent empty page into a fixable error.
    const shop = await callTool(
      server,
      'search_products',
      { query: 'x', shops: ['acme.com'] },
      boom,
    );
    expect(shop.ok).toBe(false);
    expect(String(shop.error?.message ?? shop.error)).toMatch(/gid:\/\/shopify\/Shop\//);

    const category = await callTool(
      server,
      'search_products',
      { query: 'x', categories: ['Home & Garden'] },
      boom,
    );
    expect(category.ok).toBe(false);
    expect(String(category.error?.message ?? category.error)).toMatch(/TaxonomyCategory/);
  });

  it('surfaces the seller so a caller can feed storeId back into the shops filter', async () => {
    const call = await callTool(server, 'search_products', { query: 'walnut organizer' }, () =>
      rpcResult({
        products: [
          {
            id: 'gid://shopify/p/w1',
            title: 'Walnut Organizer',
            rating: { value: 4.5, scale_min: 1, scale_max: 5, count: 7139 },
            price_range: {
              min: { amount: 7990, currency: 'USD' },
              max: { amount: 7990, currency: 'USD' },
            },
            variants: [
              {
                id: 'v1',
                url: 'https://walnutaddicted.com/products/pivo?variant=1&_gsid=abc',
                availability: { available: true },
                seller: {
                  id: 'gid://shopify/Shop/71786430654',
                  name: 'Walnut Addicted',
                  url: 'https://walnutaddicted.com',
                  // The internal domain — never the one to show a buyer.
                  domain: '4iv2q6-x1.myshopify.com',
                },
              },
            ],
          },
        ],
        pagination: {},
      }),
    );
    expect(call.ok).toBe(true);
    const [product] = call.result.structured.products;
    expect(product.storeId).toBe('gid://shopify/Shop/71786430654');
    expect(product.storeName).toBe('Walnut Addicted');
    // seller.url wins over seller.domain, which is the myshopify alias.
    expect(product.store).toBe('walnutaddicted.com');
    expect(product.storeUrl).toBe('https://walnutaddicted.com');
    // Ratings arrive only under the Shopify extension capability.
    expect(product.rating).toBe(4.5);
    expect(product.ratingCount).toBe(7139);
  });

  it('falls back to the variant URL host when no seller is present', async () => {
    const call = await callTool(server, 'search_products', { query: 'x' }, () =>
      rpcResult({
        products: [
          {
            id: 'gid://shopify/p/n1',
            title: 'No Seller',
            price_range: { min: { amount: 100, currency: 'USD' } },
            variants: [
              {
                id: 'v1',
                url: 'https://www.shop.example.com/products/thing',
                availability: { available: true },
              },
            ],
          },
        ],
        pagination: {},
      }),
    );
    expect(call.ok).toBe(true);
    const [product] = call.result.structured.products;
    expect(product.store).toBe('shop.example.com');
    expect(product.storeId).toBeNull();
    expect(product.storeName).toBeNull();
  });

  it('rejects an inverted price range with a clean validation error', async () => {
    const call = await callTool(
      server,
      'search_products',
      { query: 'sofa', minPrice: 5000, maxPrice: 100 },
      () => rpcResult({ products: [], pagination: {} }),
    );
    expect(call.ok).toBe(false);
    expect(String(call.error?.message ?? call.error)).toMatch(/minPrice must be less than/);
  });

  it('get_product resolves a URL id via lookup before fetching detail', async () => {
    const calls = [];
    const call = await callTool(
      server,
      'get_product',
      { id: 'https://shop.example.com/products/walnut-desk-organizer' },
      (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.params.name);
        if (body.params.name === 'lookup_catalog') {
          return rpcResult({ products: [{ id: 'gid://shopify/p/abc123' }] });
        }
        return rpcResult({ product: SEARCH_CONTENT.products[0] });
      },
    );
    expect(call.ok).toBe(true);
    expect(calls).toEqual(['lookup_catalog', 'get_product']);
    expect(call.result.structured.product.title).toBe('Walnut Desk Organizer');
  });

  it('converts zero-decimal currencies without dividing by 100', async () => {
    const call = await callTool(server, 'search_products', { query: 'matcha bowl' }, () =>
      rpcResult({
        products: [
          {
            id: 'gid://shopify/p/jp1',
            title: 'Matcha Bowl',
            price_range: {
              min: { amount: 5000, currency: 'JPY' },
              max: { amount: 5000, currency: 'JPY' },
            },
            variants: [
              {
                id: 'v1',
                url: 'https://shop.example.jp/products/bowl',
                availability: { available: true },
              },
            ],
          },
        ],
        pagination: {},
      }),
    );
    expect(call.ok).toBe(true);
    expect(call.result.structured.products[0].priceMin).toBe(5000);
    expect(call.result.structured.products[0].currency).toBe('JPY');
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

  it('maps buyer locale onto the UCP context field names on every tool', async () => {
    const context = { country: 'CA', language: 'en', currency: 'CAD' };
    // `country` is our friendly input name; upstream reads `address_country`
    // and ignores a bare `country`, silently pricing in the merchant currency.
    const wire = { address_country: 'CA', language: 'en', currency: 'CAD' };

    let searched;
    const search = await callTool(
      server,
      'search_products',
      { query: 'x', context },
      (_u, init) => {
        searched = JSON.parse(init.body);
        return rpcResult({ products: [], pagination: {} });
      },
    );
    expect(search.ok).toBe(true);
    expect(searched.params.arguments.catalog.context).toEqual(wire);

    let looked;
    const lookup = await callTool(
      server,
      'lookup_products',
      { ids: ['gid://shopify/p/abc123'], context },
      (_u, init) => {
        looked = JSON.parse(init.body);
        return rpcResult({ products: [] });
      },
    );
    expect(lookup.ok).toBe(true);
    expect(looked.params.arguments.catalog.context).toEqual(wire);

    let detailed;
    const detail = await callTool(
      server,
      'get_product',
      { id: 'gid://shopify/p/abc123', context },
      (_u, init) => {
        detailed = JSON.parse(init.body);
        return rpcResult({ product: SEARCH_CONTENT.products[0] });
      },
    );
    expect(detail.ok).toBe(true);
    expect(detailed.params.arguments.catalog.context).toEqual(wire);
  });

  it('omits the context entirely when no locale signal is given', async () => {
    let captured;
    const call = await callTool(server, 'search_products', { query: 'x' }, (_u, init) => {
      captured = JSON.parse(init.body);
      return rpcResult({ products: [], pagination: {} });
    });
    expect(call.ok).toBe(true);
    expect(captured.params.arguments.catalog).not.toHaveProperty('context');
  });

  it('surfaces upstream advisory messages from a search instead of dropping them', async () => {
    const call = await callTool(server, 'search_products', { query: 'x', maxPrice: 100 }, () =>
      rpcResult({
        products: [],
        messages: [
          {
            type: 'info',
            code: 'price_filter_applied',
            content: 'Price filtering was applied on a USD basis; returned prices may differ.',
          },
        ],
        pagination: {},
      }),
    );
    expect(call.ok).toBe(true);
    expect(call.result.structured.notes).toEqual([
      'price_filter_applied: Price filtering was applied on a USD basis; returned prices may differ.',
    ]);
    expect(call.result.text).toContain('USD basis');
  });

  it('separates lookup not_found ids from other advisory messages', async () => {
    const call = await callTool(
      server,
      'lookup_products',
      { ids: ['gid://shopify/p/abc123', 'https://shop.example.com/products/gone'] },
      () =>
        rpcResult({
          products: [],
          messages: [
            { code: 'not_found', content: 'https://shop.example.com/products/gone' },
            { type: 'info', code: 'price_filter_applied', content: 'Applied on a USD basis.' },
          ],
        }),
    );
    expect(call.ok).toBe(true);
    expect(call.result.structured.notFound).toEqual(['https://shop.example.com/products/gone']);
    expect(call.result.structured.notes).toEqual(['price_filter_applied: Applied on a USD basis.']);
  });

  it('keeps a lookup not_found that names the id leg out of the advisories', async () => {
    const call = await callTool(
      server,
      'lookup_products',
      { ids: ['https://shop.example.com/products/gone'] },
      () =>
        rpcResult({
          products: [],
          // Only a `$.filters...` path marks an ignored filter. A path into the
          // id leg is still a missing id, and reading any path as an advisory
          // would empty `notFound` the day upstream starts sending one.
          messages: [
            {
              code: 'not_found',
              path: '$.ids[0]',
              content: 'https://shop.example.com/products/gone',
            },
          ],
        }),
    );
    expect(call.ok).toBe(true);
    expect(call.result.structured.notFound).toEqual(['https://shop.example.com/products/gone']);
    expect(call.result.structured.notes).toEqual([]);
  });

  it('reports an unresolvable similarTo reference instead of an unexplained empty page', async () => {
    const call = await callTool(
      server,
      'search_products',
      { query: 'x', similarTo: 'gid://shopify/p/missing' },
      () =>
        rpcResult({
          products: [],
          messages: [{ code: 'not_found', content: 'gid://shopify/p/missing' }],
          pagination: {},
        }),
    );
    expect(call.ok).toBe(true);
    // A search has no `notFound` output, so the reference it could not resolve
    // has to reach the caller as a note or it vanishes.
    expect(call.result.structured.notes).toEqual(['not_found: gid://shopify/p/missing']);
  });

  it('ships an agent profile Shopify discovery will actually accept', () => {
    const profile = JSON.parse(
      readFileSync(path.join(import.meta.dirname, 'ucp-agent-profile.json'), 'utf8'),
    );
    // `services` is required, and its absence is not a style point: sending a
    // profile without it earns `-32001 profile_malformed: Missing services` and
    // every tool call fails. An agent declares the service it speaks and the
    // transport it speaks it over; it has no endpoint of its own.
    expect(profile.ucp.services['dev.ucp.shopping'][0]).toMatchObject({
      version: '2026-04-08',
      transport: 'mcp',
    });
    // The protocol version is negotiated against what the SHOP supports, before
    // capabilities are intersected at all — so it is not ours to advance. The
    // catalog accepts 2026-04-08, 2026-01-23 and draft; a profile declaring the
    // 2026-08-25 release is rejected outright, verified against the live
    // endpoint. When catalog.shopify.com/.well-known/ucp lists a newer version
    // in `supported_versions`, move this string and the capability versions
    // together — never one without the other.
    expect(profile.ucp.version).toBe('2026-04-08');
    // The Shopify extension is what makes `seller` (and with it the shop GID
    // the `shops` filter needs), `rating` and `condition` appear at all. With
    // only the base capabilities the same query returns none of them.
    expect(profile.ucp.capabilities['dev.shopify.catalog.global']).toEqual([
      { version: '2026-04-08' },
    ]);
    for (const capability of [
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.catalog.lookup',
    ]) {
      expect(profile.ucp.capabilities[capability].map((entry) => entry.version)).toEqual([
        '2026-04-08',
      ]);
    }
  });
});
