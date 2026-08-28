import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';
import { minorUnitDivisor } from './map.ts';

/**
 * Transport for the Shopify Global Catalog toolkit: the UCP JSON-RPC envelope,
 * the shipped agent profile, and id resolution. Split from extension.ts for the
 * file-size ratchet; see extension.ts for the toolkit overview.
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
    const coded = code ? ` (${code})` : '';
    throw new ToolError(`Shopify catalog error${coded}: ${detail}`, {
      retryable: body.error.code === -32_000,
    });
  }
  return body.result?.structuredContent ?? {};
}

/**
 * Map our friendly buyer-locale input onto the UCP `context` field names.
 *
 * The country key is `address_country`, not `country`: upstream ignores an
 * unrecognized key silently, and a dropped country means prices come back in
 * the merchant's own currency rather than the buyer's market — a wrong number
 * with no error attached. Returns undefined when there is no signal to send.
 */
export function buildContext(
  input: { country?: string; language?: string; currency?: string } | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined;
  // Normalized to the uppercase ISO 3166 / ISO 4217 forms the schema declares.
  // The catalog case-folds these itself today — a lowercase "ca" localizes
  // identically, verified live — so this is conformance, not a fix for an
  // observed break; `ships_to.country` is the one the schema actually pins,
  // with `pattern: ^[A-Z]{2}$`.
  const context: Record<string, string> = {
    ...(input.country && { address_country: input.country.toUpperCase() }),
    ...(input.language && { language: input.language }),
    ...(input.currency && { currency: input.currency.toUpperCase() }),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * Build the UCP search `filters` object.
 *
 * The price band carries no currency of its own. Upstream reads the band in
 * `context.currency` and FX-converts it to a USD basis — verified live, where
 * the `price_filter_applied` message reports `request_currency` taken from the
 * context and never from the band. The `currency` key this used to set was
 * inert, and pinning it to USD implied a determinism it did not buy.
 *
 * That is also why `currency` still comes in here: the band is denominated in
 * the *context* currency's minor units, so the major-to-minor scaling has to
 * follow that currency's ISO 4217 exponent. A ¥8,000 band is `8000`, not
 * `800000` — a hardcoded ×100 would widen it a hundredfold with no error.
 */
export function buildSearchFilters(input: {
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  minRatingCount?: number;
  includeUnavailable?: boolean;
  condition?: string;
  shipsTo?: string;
  shipsFrom?: string[];
  attributes?: { name: string; values: string[] }[];
  priceTier?: string[];
  currency?: string;
}): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (input.minPrice !== undefined || input.maxPrice !== undefined) {
    const scale = minorUnitDivisor(input.currency?.toUpperCase());
    filters.price = {
      ...(input.minPrice !== undefined && { min: Math.round(input.minPrice * scale) }),
      ...(input.maxPrice !== undefined && { max: Math.round(input.maxPrice * scale) }),
    };
  }
  // Ratings hang off the variant leg: `{ variant: { min, min_count } }`. The
  // flat `{ min }` this used to send is not a recognized key and was ignored.
  if (input.minRating !== undefined || input.minRatingCount !== undefined) {
    filters.rating = {
      variant: {
        ...(input.minRating !== undefined && { min: input.minRating }),
        ...(input.minRatingCount !== undefined && { min_count: input.minRatingCount }),
      },
    };
  }
  // Documented shape: `available` defaults true (sale-ready only); false widens
  // the set to include unavailable items. There is no "only out-of-stock".
  if (input.includeUnavailable) filters.available = false;
  // Documented values: "new" | "secondhand", as an array (OR logic).
  if (input.condition) filters.condition = [input.condition];
  // Documented shape: an object with country/region/postal_code.
  if (input.shipsTo) filters.ships_to = { country: input.shipsTo.toUpperCase() };
  // An array of origins, OR'd. Unlike price_tier's flat strings, each entry is
  // an object; an unrecognized code is rejected outright rather than ignored.
  if (input.shipsFrom?.length) {
    filters.ships_from = input.shipsFrom.map((country) => ({ country: country.toUpperCase() }));
  }
  // Taxonomy attributes: entries AND'd, values within an entry OR'd. An
  // unsupported name is ignored and reported in `messages[]`, not rejected.
  if (input.attributes?.length) filters.attributes = input.attributes;
  // Relative band within each product's own category — not an absolute price.
  if (input.priceTier?.length) filters.price_tier = input.priceTier;
  return filters;
}

/*
 * Two filters the endpoint advertises are deliberately not exposed, because
 * both fail closed and silently — every value returns nothing, with no message
 * saying why, which reads to a caller as "this shop sells nothing":
 *
 *  - `shops` wants shop GIDs, and no response carries one. Bare domains,
 *    myshopify domains, `gid://shopify/Shop/...` and the `_gsid` query
 *    parameter on product URLs were each tried live and each returned zero
 *    (the `_gsid` is a search id — the same value appears on results from
 *    three different storefronts).
 *  - `categories` wants a vocabulary nothing publishes. Plain names, taxonomy
 *    slugs, `Furniture > Chairs` paths and `gid://shopify/TaxonomyCategory/...`
 *    all returned zero, while `categories: []` returned the full 375 — so the
 *    field is wired, and nothing we can name matches it.
 *
 * Expose either the moment a value can be discovered from a response or named
 * from published documentation.
 */

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
