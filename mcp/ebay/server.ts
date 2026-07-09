import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * eBay — a hosted MCP server over eBay's Browse API (api.ebay.com), the
 * real-time marketplace search. Two read-only surfaces:
 *  - `search_items` — keyword/category search with price, condition, and
 *    buying-option filters, sorted (e.g. cheapest first), and
 *  - `get_item` — full detail for one listing (description, item specifics,
 *    seller, shipping, returns).
 *
 * Auth is OAuth2 client-credentials, handled declaratively by the SDK `auth`
 * block below: a free eBay developer account issues an App ID + Cert ID
 * (`EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`), which the SDK exchanges for a
 * ~2-hour application token and attaches as a `Bearer` automatically — handlers
 * just call `ctx.fetchJson`. The Browse search/get methods need only the basic
 * `…/oauth/api_scope`; no user login or contract is required. Set the secrets
 * with `trove secret set ebay EBAY_CLIENT_ID --from-stdin` (and …SECRET…).
 */

/** Base host for the eBay API (production). */
const BASE_URL = 'https://api.ebay.com';

/** Default marketplace → its listing currency (used for the price filter). */
const MARKET_CURRENCY: Record<string, string> = {
  EBAY_US: 'USD',
  EBAY_CA: 'CAD',
  EBAY_GB: 'GBP',
  EBAY_AU: 'AUD',
  EBAY_DE: 'EUR',
};

/** Map our friendly sort values to eBay Browse `sort` params (omit = best match). */
const SORT_MAP: Record<string, string | undefined> = {
  best_match: undefined,
  price_low: 'price',
  newest: 'newlyListed',
  ending_soon: 'endingSoonest',
};

/**
 * GET an eBay Browse endpoint. The `Bearer` token is minted, cached, and
 * attached automatically by the SDK `auth` block (and re-minted once on a 401);
 * here we just add the marketplace header and map eBay's error shapes.
 */
async function browseGet(
  path: string,
  marketplace: string,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  return (await ctx.fetchJson(`${BASE_URL}${path}`, {
    init: { headers: { 'X-EBAY-C-MARKETPLACE-ID': marketplace } },
    errorMap: (res, body) => {
      if (res.status === 404) return new ToolError('eBay item not found.', { retryable: false });
      if (res.status === 400) {
        let reason = '';
        try {
          const j = JSON.parse(body) as { errors?: { message?: unknown }[] };
          const m = j.errors?.[0]?.message;
          if (typeof m === 'string') reason = m;
        } catch {
          reason = body.slice(0, 120);
        }
        return new ToolError(`eBay rejected the request: ${reason || 'bad parameters'}.`, {
          retryable: false,
        });
      }
      // 401/403 (after the SDK's one automatic re-mint) and 5xx fall through to
      // the default mapping.
      return undefined;
    },
  })) as Record<string, unknown>;
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

/** Parse an eBay `{value, currency}` money object to a number, or null. */
function money(obj: unknown): { value: number | null; currency: string | null } {
  const o = (obj ?? {}) as Record<string, unknown>;
  const value =
    typeof o.value === 'string'
      ? Number.parseFloat(o.value)
      : typeof o.value === 'number'
        ? o.value
        : null;
  return {
    value: value !== null && Number.isFinite(value) ? value : null,
    currency: typeof o.currency === 'string' ? o.currency : null,
  };
}

/** The lowest shipping cost across an item's shipping options, or null. */
function shippingCost(options: unknown): { value: number | null; currency: string | null } {
  if (!Array.isArray(options) || options.length === 0) return { value: null, currency: null };
  const first = options[0] as Record<string, unknown>;
  return money(first.shippingCost);
}

/** Item specifics (brand, model, aspects) as name/value pairs, capped at 15. */
function itemAspects(body: Record<string, unknown>): { name: string; value: string }[] {
  const rawAspects = Array.isArray(body.localizedAspects) ? body.localizedAspects : [];
  return rawAspects
    .map((a) => a as Record<string, unknown>)
    .filter((a) => typeof a.name === 'string' && typeof a.value === 'string')
    .slice(0, 15)
    .map((a) => ({ name: a.name as string, value: a.value as string }));
}

/** Map an eBay item-detail response to the tool-facing result. */
function mapItemDetail(body: Record<string, unknown>, itemId: string) {
  const price = money(body.price);
  const ship = shippingCost(body.shippingOptions);
  const returnTerms = (body.returnTerms ?? {}) as Record<string, unknown>;
  return {
    itemId: typeof body.itemId === 'string' ? body.itemId : itemId,
    title: typeof body.title === 'string' ? body.title : 'Untitled',
    price: price.value,
    currency: price.currency,
    condition: typeof body.condition === 'string' ? body.condition : null,
    shortDescription:
      typeof body.shortDescription === 'string'
        ? body.shortDescription
        : typeof body.subtitle === 'string'
          ? body.subtitle
          : null,
    aspects: itemAspects(body),
    seller: nestedStr(body.seller, 'username'),
    sellerFeedbackPct: nestedStr(body.seller, 'feedbackPercentage'),
    shippingCost: ship.value,
    returnsAccepted:
      typeof returnTerms.returnsAccepted === 'boolean' ? returnTerms.returnsAccepted : null,
    location: nestedStr(body.itemLocation, 'country'),
    imageUrl: nestedStr(body.image, 'imageUrl'),
    url: typeof body.itemWebUrl === 'string' ? body.itemWebUrl : null,
  };
}

/** One-item detail summary for the human-readable text. */
function formatItemDetail(result: ReturnType<typeof mapItemDetail>): string {
  const aspectLine = result.aspects
    .slice(0, 6)
    .map((a) => `${a.name}: ${a.value}`)
    .join(' · ');
  return (
    `"${result.title}" — ${result.currency ?? ''}${result.price ?? '?'} [${result.condition ?? '?'}]` +
    `${result.seller ? `\n  Seller: ${result.seller}${result.sellerFeedbackPct ? ` (${result.sellerFeedbackPct}%)` : ''}` : ''}` +
    `${aspectLine ? `\n  ${aspectLine}` : ''}`
  );
}

export default defineMcpServer({
  auth: {
    type: 'oauth2_client_credentials',
    tokenUrl: `${BASE_URL}/identity/v1/oauth2/token`,
    clientIdSecret: 'EBAY_CLIENT_ID',
    clientSecretSecret: 'EBAY_CLIENT_SECRET',
    scope: 'https://api.ebay.com/oauth/api_scope',
    apiHost: 'api.ebay.com',
  },
  tools: [
    {
      name: 'search_items',
      title: 'eBay: Search listings',
      description:
        'Search live eBay listings by keyword, with optional price range, condition ' +
        '(NEW/USED), buying option (FIXED_PRICE/AUCTION), and marketplace. Returns ' +
        'items with price, condition, buying option, seller (+ feedback %), lowest ' +
        'shipping cost, location, and listing URL — sortable (e.g. price_low for the ' +
        'cheapest copy). Good for "cheapest used X right now" or current market prices.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Keywords, e.g. "Fender Stratocaster American".'),
        minPrice: z.number().min(0).optional().describe('Minimum price (marketplace currency).'),
        maxPrice: z.number().min(0).optional().describe('Maximum price (marketplace currency).'),
        condition: z.enum(['NEW', 'USED']).optional().describe('Restrict to new or used items.'),
        buyingOption: z
          .enum(['FIXED_PRICE', 'AUCTION'])
          .optional()
          .describe('Restrict to Buy-It-Now or auction listings.'),
        marketplace: z
          .enum(['EBAY_US', 'EBAY_CA', 'EBAY_GB', 'EBAY_AU', 'EBAY_DE'])
          .default('EBAY_US')
          .describe('eBay marketplace (default EBAY_US).'),
        sort: z
          .enum(['best_match', 'price_low', 'newest', 'ending_soon'])
          .default('best_match')
          .describe('Result ordering.'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max items (1–25).'),
      }),
      output: z.object({
        total: z.number(),
        count: z.number(),
        items: z.array(
          z.object({
            itemId: z.string(),
            title: z.string(),
            price: z.number().nullable(),
            currency: z.string().nullable(),
            condition: z.string().nullable(),
            buyingOptions: z.array(z.string()),
            seller: z.string().nullable(),
            sellerFeedbackPct: z.string().nullable(),
            shippingCost: z.number().nullable(),
            location: z.string().nullable(),
            imageUrl: z.string().nullable(),
            url: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, minPrice, maxPrice, condition, buyingOption, marketplace, sort, limit } =
          args;
        const currency = MARKET_CURRENCY[marketplace] ?? 'USD';
        const filters: string[] = [];
        if (minPrice !== undefined || maxPrice !== undefined) {
          const lo = minPrice !== undefined ? String(minPrice) : '';
          const hi = maxPrice !== undefined ? String(maxPrice) : '';
          filters.push(`price:[${lo}..${hi}],priceCurrency:${currency}`);
        }
        if (condition) filters.push(`conditions:{${condition}}`);
        if (buyingOption) filters.push(`buyingOptions:{${buyingOption}}`);

        const params = new URLSearchParams({ q: query, limit: String(limit) });
        if (filters.length) params.set('filter', filters.join(','));
        const sortParam = SORT_MAP[sort];
        if (sortParam) params.set('sort', sortParam);
        ctx.log('search_items', { query, marketplace, sort, limit });

        const body = await browseGet(
          `/buy/browse/v1/item_summary/search?${params}`,
          marketplace,
          ctx,
        );
        const summaries = Array.isArray(body.itemSummaries) ? body.itemSummaries : [];
        const items = summaries.map((s) => {
          const it = s as Record<string, unknown>;
          const price = money(it.price);
          const ship = shippingCost(it.shippingOptions);
          return {
            itemId: typeof it.itemId === 'string' ? it.itemId : '',
            title: typeof it.title === 'string' ? it.title : 'Untitled',
            price: price.value,
            currency: price.currency,
            condition: typeof it.condition === 'string' ? it.condition : null,
            buyingOptions: Array.isArray(it.buyingOptions)
              ? (it.buyingOptions as unknown[]).filter((b): b is string => typeof b === 'string')
              : [],
            seller: nestedStr(it.seller, 'username'),
            sellerFeedbackPct: nestedStr(it.seller, 'feedbackPercentage'),
            shippingCost: ship.value,
            location: nestedStr(it.itemLocation, 'country'),
            imageUrl:
              nestedStr(it.image, 'imageUrl') ?? nestedStr(it.thumbnailImages, '0', 'imageUrl'),
            url: typeof it.itemWebUrl === 'string' ? it.itemWebUrl : null,
          };
        });
        const total = typeof body.total === 'number' ? body.total : items.length;
        if (items.length === 0) {
          return {
            text: `No eBay listings for "${query}".`,
            structured: { total: 0, count: 0, items: [] },
          };
        }
        const lines = items
          .map(
            (i) =>
              `  ${i.currency ?? ''}${i.price ?? '?'} — ${i.title} [${i.condition ?? '?'}]` +
              `${i.shippingCost !== null ? ` +${i.currency ?? ''}${i.shippingCost} ship` : ''}` +
              `${i.seller ? ` · ${i.seller}${i.sellerFeedbackPct ? ` (${i.sellerFeedbackPct}%)` : ''}` : ''}`,
          )
          .join('\n');
        return {
          text: `${items.length} of ${total} eBay listing(s) on ${marketplace}:\n${lines}`,
          structured: { total, count: items.length, items },
        };
      },
    },
    {
      name: 'get_item',
      title: 'eBay: Get listing details',
      description:
        'Fetch full detail for one eBay listing by itemId (from search_items, format ' +
        '"v1|<id>|<variation>"): title, price, condition, a short description, item ' +
        'specifics (brand, model, aspects), seller + feedback, shipping, return policy, ' +
        'and item location.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        itemId: z.string().min(3).describe('eBay RESTful item id, e.g. "v1|256...|0".'),
        marketplace: z
          .enum(['EBAY_US', 'EBAY_CA', 'EBAY_GB', 'EBAY_AU', 'EBAY_DE'])
          .default('EBAY_US')
          .describe('eBay marketplace (default EBAY_US).'),
      }),
      output: z.object({
        itemId: z.string(),
        title: z.string(),
        price: z.number().nullable(),
        currency: z.string().nullable(),
        condition: z.string().nullable(),
        shortDescription: z.string().nullable(),
        aspects: z.array(z.object({ name: z.string(), value: z.string() })),
        seller: z.string().nullable(),
        sellerFeedbackPct: z.string().nullable(),
        shippingCost: z.number().nullable(),
        returnsAccepted: z.boolean().nullable(),
        location: z.string().nullable(),
        imageUrl: z.string().nullable(),
        url: z.string().nullable(),
      }),
      async handler(args, ctx) {
        const { itemId, marketplace } = args;
        ctx.log('get_item', { itemId, marketplace });
        const body = await browseGet(
          `/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
          marketplace,
          ctx,
        );
        const result = mapItemDetail(body, itemId);
        return {
          text: formatItemDetail(result),
          structured: result,
        };
      },
    },
  ],
});
