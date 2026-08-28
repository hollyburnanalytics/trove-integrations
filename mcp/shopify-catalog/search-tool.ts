import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { buildContext, buildSearchFilters, ucpCall } from './catalog-client.ts';
import { contextInput, SHOP_GID, SHOPIFY_GID, TAXONOMY_GID } from './inputs.ts';
import { formatProduct, mapSearchPage } from './map.ts';

/**
 * `search_products` — free-text, similar-item and visual search over the UCP
 * global catalog. Split from extension.ts for the file-size ratchet; see
 * extension.ts for the toolkit overview.
 */
export const searchProductsTool = tool({
  name: 'search_products',
  title: 'Shopify Global Catalog: Search products',
  description:
    'Search products across every Shopify storefront worldwide (the UCP global ' +
    'catalog). Free-text query with optional price range, availability, ' +
    'condition, taxonomy-attribute (colour/size), relative price-tier and ' +
    'shipping-origin filters plus buyer-locale context. Returns compact product ' +
    'summaries — title, description, price range, storefront domain, stock ' +
    'flag, product-page URL — with a cursor for paging. Also does ' +
    'similar-item search (similarTo: a catalog GID — a URL or bare id is ' +
    'rejected) and visual search ' +
    '(image: inline base64 bytes). A price band is read in context.currency ' +
    '(default USD) and FX-converted to a USD basis upstream, while displayed ' +
    "prices are localized to the buyer's market — so a band can admit an item " +
    'whose shown price falls outside it; notes[] carries the upstream advisory ' +
    'saying exactly how the band was applied. Discovery only: the ' +
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
      .regex(SHOPIFY_GID, 'similarTo must be a Shopify GID, e.g. "gid://shopify/p/abc123".')
      .optional()
      .describe('A catalog product/variant GID — find visually/semantically similar products.'),
    image: z
      .object({
        contentType: z.string().describe('MIME type, e.g. "image/jpeg".'),
        data: z.string().describe('Base64-encoded image bytes.'),
      })
      .optional()
      .describe(
        'An inline base64 image — visual search for products resembling it. Upstream ' +
          'takes bytes, not a URL, and this server may only reach the catalog host, ' +
          'so the caller supplies the encoded image.',
      ),
    minPrice: z.number().min(0).optional().describe('Minimum price (major units).'),
    maxPrice: z.number().min(0).optional().describe('Maximum price (major units).'),
    minRating: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe(
        'Minimum variant rating (0–5). Filters upstream, but the catalog does not ' +
          'return rating values, so matched products come back with rating: null.',
      ),
    minRatingCount: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Minimum number of reviews behind that rating.'),
    includeUnavailable: z
      .boolean()
      .optional()
      .describe(
        'By default only sale-ready items return; true widens results to include ' +
          'unavailable items (there is no "only out-of-stock" filter upstream).',
      ),
    condition: z
      .enum(['new', 'secondhand'])
      .optional()
      .describe('Item condition ("secondhand" surfaces genuinely used/antique stock).'),
    shipsTo: z
      .string()
      .length(2)
      .optional()
      .describe('ISO 3166 country the item must ship to, e.g. "CA".'),
    shipsFrom: z
      .array(z.string().length(2))
      .optional()
      .describe(
        'ISO 3166 origin countries; an item matches if it ships from any of them. ' +
          'An unrecognized code is rejected, not ignored.',
      ),
    attributes: z
      .array(
        z.object({
          name: z.string().describe('Taxonomy attribute: "Color", "Size" or "Target gender".'),
          values: z
            .array(z.string())
            .min(1)
            .max(50)
            .describe('Values for this attribute, e.g. ["Red","Blue"]. OR within an entry.'),
        }),
      )
      .max(25)
      .optional()
      .describe(
        'Shopify taxonomy attribute filters, AND-ed across entries. Only "Color", ' +
          '"Size" and "Target gender" are supported today — any other name is ' +
          'ignored upstream and reported in notes[], not rejected, so check notes[] ' +
          'before trusting that the filter narrowed anything.',
      ),
    shops: z
      .array(z.string().regex(SHOP_GID, 'Each shop must be a "gid://shopify/Shop/..." GID.'))
      .max(1000)
      .optional()
      .describe(
        'Restrict results to these shops (OR-ed, max 1000). Take the GID from a ' +
          "previous result's storeId — it is the only place one is published.",
      ),
    categories: z
      .array(
        z
          .string()
          .regex(TAXONOMY_GID, 'Each category must be a "gid://shopify/TaxonomyCategory/..." GID.'),
      )
      .optional()
      .describe(
        'Shopify taxonomy category GIDs, OR-ed, e.g. ' +
          '"gid://shopify/TaxonomyCategory/hg". The vertical prefix is what matters: ' +
          'hg (Home & Garden — includes furniture), aa (Apparel), sg (Sporting Goods), ' +
          'hb (Health & Beauty), el (Electronics), bi (Business & Industrial), ' +
          'ha (Hardware), ae (Arts & Entertainment), ap (Animals & Pet Supplies), ' +
          'me (Media), fb (Food & Beverages), lb (Luggage & Bags). An id that matches ' +
          'nothing returns zero results without an advisory, so widen before concluding ' +
          'a category is empty.',
      ),
    priceTier: z
      .array(z.enum(['low', 'medium', 'high']))
      .optional()
      .describe(
        "Relative price band within each product's own category (OR-ed), not an " +
          'absolute amount — "low" office chairs still cost more than "high" socks. ' +
          'Use it for "cheap for what it is"; use minPrice/maxPrice for real money.',
      ),
    context: contextInput,
    cursor: z.string().optional().describe('Pagination cursor from a previous page.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max products (1–50).'),
  }),
  output: z.object({
    totalEstimate: z
      .number()
      .nullable()
      .describe('Rough result-count estimate; fluctuates between calls — do not present as exact.'),
    count: z.number(),
    nextCursor: z.string().nullable(),
    notes: z
      .array(z.string())
      .describe('Upstream advisories about how the request was interpreted.'),
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
        storeUrl: z.string().nullable(),
        storeId: z
          .string()
          .nullable()
          .describe('Shop GID — pass back via the shops filter to search one storefront.'),
        storeName: z.string().nullable(),
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
      image,
      minPrice,
      maxPrice,
      minRating,
      minRatingCount,
      includeUnavailable,
      condition,
      shipsTo,
      shipsFrom,
      attributes,
      priceTier,
      shops,
      categories,
      context,
      cursor,
      limit,
    } = args;
    if (!query && !similarTo && !image) {
      throw new ToolError('Provide a query, a similarTo product GID, or an image.', {
        retryable: false,
      });
    }
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
      throw new ToolError('minPrice must be less than or equal to maxPrice.', {
        retryable: false,
      });
    }
    const filters = buildSearchFilters({
      minPrice,
      maxPrice,
      minRating,
      minRatingCount,
      includeUnavailable,
      condition,
      shipsTo,
      shipsFrom,
      attributes,
      priceTier,
      shops,
      categories,
      // Not sent on the wire — the band has no currency key. It scales the
      // major-unit input into the context currency's minor units.
      currency: context?.currency,
    });
    // A `like` item is a strict oneOf upstream: a GID, or inline image bytes.
    const like = [
      ...(similarTo ? [{ id: similarTo }] : []),
      ...(image ? [{ image: { content_type: image.contentType, data: image.data } }] : []),
    ];
    ctx.log('search_products', { query, similarTo, limit });
    const wireContext = buildContext(context);

    const result = await ucpCall(
      'search_catalog',
      {
        ...(query && { query }),
        ...(like.length > 0 && { like }),
        view: 'offer',
        ...(Object.keys(filters).length > 0 && { filters }),
        ...(wireContext && { context: wireContext }),
        pagination: { limit, ...(cursor && { cursor }) },
      },
      ctx,
    );
    const structured = mapSearchPage(result);
    const listing =
      structured.products.length === 0
        ? `No products found for "${query ?? similarTo ?? 'the supplied image'}".`
        : structured.products.map(formatProduct).join('\n');
    const notes = structured.notes.map((n) => `\nNote: ${n}`).join('');
    return { structured, text: listing + notes };
  },
});
