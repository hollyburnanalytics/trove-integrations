import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

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

/** Shopify's UCP catalog MCP endpoint. */
const ENDPOINT = 'https://catalog.shopify.com/api/ucp/mcp';

/** The public agent profile UCP discovery fetches on every request. */
const AGENT_PROFILE =
  'https://raw.githubusercontent.com/hollyburnanalytics/trove-integrations/main/mcp/shopify-catalog/ucp-agent-profile.json';

/** UCP JSON-RPC error payload shape. */
interface JsonRpcError {
  code?: number;
  message?: string;
  data?: { code?: string; content?: string };
}

/**
 * Call one upstream UCP catalog tool: wrap `catalog` arguments in the JSON-RPC
 * `tools/call` envelope with our agent profile, POST it, and unwrap the
 * `structuredContent` result. JSON-RPC errors map to ToolErrors with the UCP
 * failure detail (e.g. `profile_unreachable`) surfaced.
 */
async function ucpCall(
  tool: string,
  catalog: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const body = (await ctx.fetchJson(ENDPOINT, {
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: {
            meta: { 'ucp-agent': { profile: AGENT_PROFILE } },
            catalog,
          },
        },
      }),
    },
  })) as { result?: { structuredContent?: Record<string, unknown> }; error?: JsonRpcError };

  if (body.error) {
    const detail = body.error.data?.content ?? body.error.message ?? 'unknown error';
    const code = body.error.data?.code ?? String(body.error.code ?? '');
    throw new ToolError(`Shopify catalog error${code ? ` (${code})` : ''}: ${detail}`, {
      retryable: body.error.code === -32000,
    });
  }
  return body.result?.structuredContent ?? {};
}

/** A UCP `Price` (`amount` in minor units + ISO currency) as a decimal, or null. */
function price(obj: unknown): { amount: number | null; currency: string | null } {
  const o = (obj ?? {}) as Record<string, unknown>;
  const minor = typeof o.amount === 'number' ? o.amount : null;
  const currency = typeof o.currency === 'string' ? o.currency : null;
  // UCP amounts are minor units; every currency the catalog serves today uses
  // exponent 2. Presented as major units for readability.
  return { amount: minor !== null ? minor / 100 : null, currency };
}

/** Read a nested string by path, or null. */
function nestedStr(obj: unknown, ...path: string[]): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === 'string' ? cur : null;
}

/** Map one UCP product to the compact tool-facing summary. */
function mapProduct(raw: unknown) {
  const p = (raw ?? {}) as Record<string, unknown>;
  const range = (p.price_range ?? {}) as Record<string, unknown>;
  const min = price(range.min);
  const max = price(range.max);
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const media = Array.isArray(p.media) ? p.media : [];
  const rating = (p.rating ?? {}) as Record<string, unknown>;
  return {
    id: typeof p.id === 'string' ? p.id : null,
    title: typeof p.title === 'string' ? p.title : 'Untitled',
    description: typeof p.description === 'string' ? p.description.slice(0, 500) : null,
    url: typeof p.url === 'string' ? p.url : null,
    priceMin: min.amount,
    priceMax: max.amount,
    currency: min.currency ?? max.currency,
    seller: nestedStr(p.seller, 'name') ?? nestedStr(p.seller, 'shop_name'),
    sellerUrl: nestedStr(p.seller, 'url'),
    variantCount: variants.length,
    rating: typeof rating.value === 'number' ? rating.value : null,
    ratingCount: typeof rating.count === 'number' ? rating.count : null,
    imageUrl: nestedStr(media[0], 'url'),
  };
}

/** One-line product summary for the human-readable text block. */
function formatProduct(product: ReturnType<typeof mapProduct>): string {
  const priceLabel =
    product.priceMin !== null
      ? product.priceMin === product.priceMax || product.priceMax === null
        ? `${product.currency ?? ''} ${product.priceMin}`
        : `${product.currency ?? ''} ${product.priceMin}–${product.priceMax}`
      : 'price n/a';
  const ratingLabel =
    product.rating !== null
      ? ` ★${product.rating}${product.ratingCount ? ` (${product.ratingCount})` : ''}`
      : '';
  return `"${product.title}" — ${priceLabel}${product.seller ? ` · ${product.seller}` : ''}${ratingLabel}\n  ${product.url ?? product.id ?? ''}`;
}

/** Shared context input: buyer signals for relevance and localization. */
const contextInput = z
  .object({
    country: z.string().length(2).optional().describe('ISO 3166 country, e.g. "CA".'),
    language: z.string().optional().describe('BCP-47 language, e.g. "en".'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency, e.g. "CAD".'),
  })
  .optional()
  .describe('Buyer locale signals for relevance, localization, and pricing.');

export default defineMcpServer({
  tools: [
    {
      name: 'search_products',
      title: 'Shopify Global Catalog: Search products',
      description:
        'Search products across every Shopify storefront worldwide (the UCP global ' +
        'catalog). Free-text query with optional price range, availability, and ' +
        'condition filters plus buyer-locale context. Returns compact product ' +
        'summaries — title, price range, seller, rating, URL — with a cursor for ' +
        'paging. Good for "find X to buy", price comparison across merchants, and ' +
        'discovering who sells a niche product.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Free-text search, e.g. "walnut desk organizer".'),
        minPrice: z.number().min(0).optional().describe('Minimum price (major units).'),
        maxPrice: z.number().min(0).optional().describe('Maximum price (major units).'),
        availability: z
          .enum(['in_stock', 'out_of_stock'])
          .optional()
          .describe('Restrict by stock status.'),
        condition: z.enum(['new', 'used', 'refurbished']).optional().describe('Item condition.'),
        context: contextInput,
        cursor: z.string().optional().describe('Pagination cursor from a previous page.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max products (1–50).'),
      }),
      output: z.object({
        totalEstimate: z.number().nullable(),
        count: z.number(),
        nextCursor: z.string().nullable(),
        products: z.array(
          z.object({
            id: z.string().nullable(),
            title: z.string(),
            description: z.string().nullable(),
            url: z.string().nullable(),
            priceMin: z.number().nullable(),
            priceMax: z.number().nullable(),
            currency: z.string().nullable(),
            seller: z.string().nullable(),
            sellerUrl: z.string().nullable(),
            variantCount: z.number(),
            rating: z.number().nullable(),
            ratingCount: z.number().nullable(),
            imageUrl: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, minPrice, maxPrice, availability, condition, context, cursor, limit } = args;
        const filters: Record<string, unknown> = {};
        if (minPrice !== undefined || maxPrice !== undefined) {
          filters.price = {
            ...(minPrice !== undefined && { min: Math.round(minPrice * 100) }),
            ...(maxPrice !== undefined && { max: Math.round(maxPrice * 100) }),
          };
        }
        if (availability) filters.availability = availability;
        if (condition) filters.condition = condition;
        ctx.log('search_products', { query, limit });

        const result = await ucpCall(
          'search_catalog',
          {
            query,
            ...(Object.keys(filters).length > 0 && { filters }),
            ...(context && { context }),
            pagination: { limit, ...(cursor && { cursor }) },
          },
          ctx,
        );
        const rawProducts = Array.isArray(result.products) ? result.products : [];
        const products = rawProducts.map(mapProduct);
        const pagination = (result.pagination ?? {}) as Record<string, unknown>;
        const structured = {
          totalEstimate: typeof pagination.total_count === 'number' ? pagination.total_count : null,
          count: products.length,
          nextCursor: typeof pagination.next_cursor === 'string' ? pagination.next_cursor : null,
          products,
        };
        const text =
          products.length === 0
            ? `No products found for "${query}".`
            : products.map(formatProduct).join('\n');
        return { structured, text };
      },
    },
    {
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
        products: z.array(z.record(z.unknown())),
      }),
      async handler(args, ctx) {
        ctx.log('lookup_products', { count: args.ids.length });
        const result = await ucpCall(
          'lookup_catalog',
          { ids: args.ids, ...(args.context && { context: args.context }) },
          ctx,
        );
        const rawProducts = Array.isArray(result.products) ? result.products : [];
        const products = rawProducts.map(mapProduct);
        const messages = Array.isArray(result.messages) ? result.messages : [];
        const notFound = messages
          .map((m) => (m ?? {}) as Record<string, unknown>)
          .filter((m) => m.code === 'not_found')
          .map((m) => (typeof m.content === 'string' ? m.content : 'unknown id'));
        const structured = { count: products.length, notFound, products };
        const text =
          products.length === 0
            ? 'No products found for the given ids.'
            : products.map(formatProduct).join('\n') +
              (notFound.length > 0 ? `\nNot found: ${notFound.join(', ')}` : '');
        return { structured, text };
      },
    },
    {
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
        product: z.record(z.unknown()).nullable(),
        options: z.array(z.record(z.unknown())),
        variants: z.array(z.record(z.unknown())),
      }),
      async handler(args, ctx) {
        ctx.log('get_product', { id: args.id });
        const result = await ucpCall(
          'get_product',
          {
            id: args.id,
            ...(args.selected && { selected: args.selected }),
            ...(args.context && { context: args.context }),
          },
          ctx,
        );
        const rawProducts = Array.isArray(result.products) ? result.products : [];
        const first = (rawProducts[0] ?? null) as Record<string, unknown> | null;
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
        const text = summary
          ? `${formatProduct(summary)}${variantLines ? `\n${variantLines}` : ''}`
          : `No product found for "${args.id}".`;
        return { structured, text };
      },
    },
  ],
});
