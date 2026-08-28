import { defineToolkit, tool, z } from '@ontrove/extend/toolkit';
import { buildContext, resolveCatalogId, ucpCall } from './catalog-client.ts';
import { contextInput } from './inputs.ts';
import { formatProduct, mapMessages, mapProduct, price } from './map.ts';
import { searchProductsTool } from './search-tool.ts';

/**
 * Shopify Global Catalog — a hosted MCP server over Shopify's Universal
 * Commerce Protocol (UCP) catalog endpoint (catalog.shopify.com), the
 * cross-merchant product index for agent commerce. Three read-only surfaces
 * mirroring the UCP catalog capabilities:
 *  - `search_products` — free-text search across all Shopify storefronts with
 *    price/availability/condition/shipping filters and cursor pagination,
 *  - `lookup_products` — batch lookup by UPID/variant id/product URL, and
 *  - `get_product`  — one product in full detail, with option selection.
 *
 * The upstream endpoint itself speaks MCP JSON-RPC, so each tool call here is
 * a `tools/call` POST forwarded with our arguments. UCP requires every request
 * to carry a public agent-profile URL (`meta["ucp-agent"].profile`) declaring
 * the caller's capabilities; ours is the `ucp-agent-profile.json` shipped
 * alongside this server and served from this repository. No key or account is
 * required. Spec: https://ucp.dev/2026-04-08/specification/catalog/mcp/
 */

export default defineToolkit({
  id: 'shopify-catalog',
  name: 'Shopify Global Catalog',
  description:
    "Search products across every Shopify storefront worldwide via Shopify's Universal Commerce Protocol catalog — free-text and similar-item search with price, availability, condition, and shipping filters, plus variant-level product detail. Real-time, no key required.",
  icon: '🛍️',
  version: '2.0.0',
  secrets: [],
  egress: ['catalog.shopify.com'],
  scopes: [],
  visibility: 'shared',
  tools: [
    searchProductsTool,
    tool({
      name: 'lookup_products',
      title: 'Shopify Global Catalog: Look up products by id or URL',
      description:
        'Look up one or more known products or variants by identifier — a UCP product ' +
        'id (gid://shopify/p/…), a variant id, or a product page URL (1–50 per call). ' +
        'Returns the same compact summaries as search, plus which ids were not found. ' +
        'Use when you already have product links/ids and need current price and ' +
        'availability.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe('Product/variant ids or product URLs.'),
        context: contextInput,
      }),
      output: z.object({
        count: z.number(),
        notFound: z.array(z.string()),
        notes: z
          .array(z.string())
          .describe('Upstream advisories about how the request was interpreted.'),
        products: z.array(z.record(z.string(), z.unknown())),
      }),
      async handler(args, ctx) {
        ctx.log('lookup_products', { count: args.ids.length });
        const wireContext = buildContext(args.context);
        const result = await ucpCall(
          'lookup_catalog',
          { ids: args.ids, view: 'offer', ...(wireContext && { context: wireContext }) },
          ctx,
        );
        const rawProducts = Array.isArray(result.products) ? result.products : [];
        const products = rawProducts.map(mapProduct);
        const { notes, notFound } = mapMessages(result);
        const structured = { count: products.length, notFound, notes, products };
        const missing = notFound.length > 0 ? `\nNot found: ${notFound.join(', ')}` : '';
        const listing =
          products.length === 0
            ? 'No products found for the given ids.'
            : products.map(formatProduct).join('\n');
        const advisories = notes.map((n) => `\nNote: ${n}`).join('');
        return { structured, text: listing + missing + advisories };
      },
    }),
    tool({
      name: 'get_product',
      title: 'Shopify Global Catalog: Get product detail',
      description:
        'Full detail for one product: description, options with availability, and ' +
        'variants with individual prices. Optionally narrow by option selections ' +
        '(e.g. Color=Blue) to find the exact variant and its price/stock. Use after ' +
        'search/lookup when the buyer needs a specific configuration.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('Product or variant id, or product URL.'),
        selected: z
          .array(z.object({ name: z.string(), label: z.string() }))
          .optional()
          .describe('Option selections, e.g. [{"name":"Color","label":"Blue"}].'),
        context: contextInput,
      }),
      output: z.object({
        product: z.record(z.string(), z.unknown()).nullable(),
        options: z.array(z.record(z.string(), z.unknown())),
        variants: z.array(z.record(z.string(), z.unknown())),
      }),
      async handler(args, ctx) {
        ctx.log('get_product', { id: args.id });
        const id = await resolveCatalogId(args.id, ctx);
        const wireContext = buildContext(args.context);
        const result = await ucpCall(
          'get_product',
          {
            id,
            view: 'offer',
            ...(args.selected && { selected: args.selected }),
            ...(wireContext && { context: wireContext }),
          },
          ctx,
        );
        const first = (result.product ?? null) as Record<string, unknown> | null;
        const summary = first ? mapProduct(first) : null;
        const options = first && Array.isArray(first.options) ? first.options : [];
        const variants = first && Array.isArray(first.variants) ? first.variants : [];
        const variantLines = variants
          .slice(0, 8)
          .map((v) => {
            const variant = (v ?? {}) as Record<string, unknown>;
            const vp = price(variant.price);
            const label = typeof variant.title === 'string' ? variant.title : 'variant';
            return `  - ${label}: ${vp.currency ?? ''} ${vp.amount ?? '?'}`;
          })
          .join('\n');
        const structured = {
          product: summary ? { ...summary, options, variantCount: variants.length } : null,
          options: options.map((o) => (o ?? {}) as Record<string, unknown>),
          variants: variants.map((v) => (v ?? {}) as Record<string, unknown>),
        };
        const variants2 = variantLines ? `\n${variantLines}` : '';
        const text = summary
          ? `${formatProduct(summary)}${variants2}`
          : `No product found for "${args.id}".`;
        return { structured, text };
      },
    }),
  ],
});
