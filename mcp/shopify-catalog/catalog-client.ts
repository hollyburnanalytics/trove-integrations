import type { ToolContext } from '@ontrove/mcp';
import { ToolError } from '@ontrove/mcp';

/**
 * Transport for the Shopify Global Catalog toolkit: the UCP JSON-RPC envelope,
 * the shipped agent profile, and id resolution. Split from server.ts for the
 * file-size ratchet; see server.ts for the toolkit overview.
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
export async function ucpCall(
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
export function buildSearchFilters(input: {
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

/**
 * Resolve a caller-supplied id to a catalog product id. The upstream
 * get_product accepts ids but not product URLs (verified live), while
 * lookup_catalog resolves URLs fine — so a URL is first resolved via lookup.
 */
export async function resolveCatalogId(id: string, ctx: ToolContext): Promise<string> {
  if (!/^https?:\/\//i.test(id)) return id;
  const looked = await ucpCall('lookup_catalog', { ids: [id], view: 'offer' }, ctx);
  const found = Array.isArray(looked.products) ? looked.products : [];
  const resolved = ((found[0] ?? {}) as Record<string, unknown>).id;
  if (typeof resolved !== 'string') {
    throw new ToolError(`No catalog product found for URL: ${id}`, { retryable: false });
  }
  return resolved;
}
