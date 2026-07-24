import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { formatProduct, mapProduct, price } from './map.ts';

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

/**
 * The public agent profile UCP discovery fetches on every request. Served via
 * jsDelivr (not GitHub raw) because discovery requires an `application/json`
 * content type, which raw.githubusercontent.com does not send. The file lives
 * in this directory (`ucp-agent-profile.json`).
 */
const AGENT_PROFILE =
  'https://cdn.jsdelivr.net/gh/hollyburnanalytics/trove-integrations@main/mcp/shopify-catalog/ucp-agent-profile.json';

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

/**
 * Build the UCP search `filters` object. Price bands pin an explicit currency
 * (verified live: without one the band is interpreted in an unspecified
 * currency and can disagree with the displayed merchant-currency prices).
 */
function buildSearchFilters(input: {
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  availability?: string;
  condition?: string;
  currency?: string;
}): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (input.minPrice !== undefined || input.maxPrice !== undefined) {
    filters.price = {
      ...(input.minPrice !== undefined && { min: Math.round(input.minPrice * 100) }),
      ...(input.maxPrice !== undefined && { max: Math.round(input.maxPrice * 100) }),
      currency: input.currency ?? 'USD',
    };
  }
  if (input.minRating !== undefined) filters.rating = { min: input.minRating };
  if (input.availability) filters.availability = input.availability;
  if (input.condition) filters.condition = input.condition;
  return filters;
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
        'summaries — title, description, price range, storefront domain, stock ' +
        'flag, product-page URL — with a cursor for paging. Also does ' +
        'similar-item search (similarTo: a product id) and visual search ' +
        '(imageUrl). Price filters apply in context.currency (default USD); ' +
        "displayed prices stay in each merchant's own currency. Discovery only: the " +
        'catalog is semantic (nearest matches always return, even for nonsense ' +
        'queries; treat weak matches skeptically), totalEstimate is a rough ' +
        'fluctuating estimate, and locale context localizes results but does NOT ' +
        'confirm the merchant ships to that country — check the product page for ' +
        'fulfillment. Good for "find X to buy", price comparison across merchants, ' +
        'and discovering who sells a niche product.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Free-text search, e.g. "walnut desk organizer".'),
        similarTo: z
          .string()
          .optional()
          .describe('A catalog product id — find visually/semantically similar products.'),
        imageUrl: z
          .string()
          .url()
          .optional()
          .describe('An image URL — visual search for products resembling it.'),
        minPrice: z.number().min(0).optional().describe('Minimum price (major units).'),
        maxPrice: z.number().min(0).optional().describe('Maximum price (major units).'),
        minRating: z.number().min(0).max(5).optional().describe('Minimum product rating (0–5).'),
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
        totalEstimate: z
          .number()
          .nullable()
          .describe(
            'Rough result-count estimate; fluctuates between calls — do not present as exact.',
          ),
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
            store: z.string().nullable(),
            available: z.boolean(),
            variantCount: z.number(),
            rating: z.number().nullable(),
            ratingCount: z.number().nullable(),
            imageUrl: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const {
          query,
          similarTo,
          imageUrl,
          minPrice,
          maxPrice,
          minRating,
          availability,
          condition,
          context,
          cursor,
          limit,
        } = args;
        if (!query && !similarTo && !imageUrl) {
          throw new ToolError('Provide a query, a similarTo product id, or an imageUrl.', {
            retryable: false,
          });
        }
        const filters = buildSearchFilters({
          minPrice,
          maxPrice,
          minRating,
          availability,
          condition,
          currency: context?.currency,
        });
        const like = [
          ...(similarTo ? [{ id: similarTo }] : []),
          ...(imageUrl ? [{ image: imageUrl }] : []),
        ];
        ctx.log('search_products', { query, similarTo, limit });

        const result = await ucpCall(
          'search_catalog',
          {
            ...(query && { query }),
            ...(like.length > 0 && { like }),
            view: 'offer',
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
          nextCursor:
            pagination.has_next_page === true && typeof pagination.cursor === 'string'
              ? pagination.cursor
              : null,
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
          { ids: args.ids, view: 'offer', ...(args.context && { context: args.context }) },
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
            view: 'offer',
            ...(args.selected && { selected: args.selected }),
            ...(args.context && { context: args.context }),
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
        const text = summary
          ? `${formatProduct(summary)}${variantLines ? `\n${variantLines}` : ''}`
          : `No product found for "${args.id}".`;
        return { structured, text };
      },
    },
  ],
});
