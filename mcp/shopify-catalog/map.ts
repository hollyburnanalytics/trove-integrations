/**
 * UCP product mapping for the Shopify Global Catalog toolkit: raw catalog
 * products (see the probes in the PR) to the compact tool-facing summaries.
 * Split from extension.ts purely for file-size hygiene.
 */

/** ISO 4217 currencies with no minor unit (exponent 0). */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** ISO 4217 currencies with three-decimal minor units (exponent 3). */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/**
 * The ISO 4217 exponent as a divisor: minor units to major, per currency.
 * Absent/unknown currency falls back to the two-decimal majority (and to USD's
 * exponent, which is what the catalog assumes when no currency is supplied).
 */
export function minorUnitDivisor(currency: string | null | undefined): number {
  if (currency && ZERO_DECIMAL.has(currency)) return 1;
  if (currency && THREE_DECIMAL.has(currency)) return 1000;
  return 100;
}

/** A UCP `Price` (`amount` in minor units + ISO currency) as a decimal, or null. */
export function price(obj: unknown): { amount: number | null; currency: string | null } {
  const o = (obj ?? {}) as Record<string, unknown>;
  const minor = typeof o.amount === 'number' ? o.amount : null;
  const currency = typeof o.currency === 'string' ? o.currency : null;
  // UCP amounts are minor units; the divisor follows the currency's ISO 4217
  // exponent (JPY/KRW etc. have none, a few dinar currencies have three).
  const divisor = minorUnitDivisor(currency);
  return { amount: minor === null ? null : minor / divisor, currency };
}

/** The first variant image URL, for products whose own media array is empty. */
function firstVariantImage(variants: unknown[]): string | null {
  for (const v of variants) {
    const media = ((v ?? {}) as Record<string, unknown>).media;
    if (Array.isArray(media)) {
      const url = nestedStr(media[0], 'url');
      if (url) return url;
    }
  }
  return null;
}

/** The first variant's product-page URL, tracking params stripped. */
function productUrl(variants: unknown[]): string | null {
  for (const v of variants) {
    const raw = ((v ?? {}) as Record<string, unknown>).url;
    if (typeof raw !== 'string') continue;
    try {
      const u = new URL(raw);
      const variant = u.searchParams.get('variant');
      u.search = '';
      if (variant) u.searchParams.set('variant', variant);
      return u.href;
    } catch {
      return raw;
    }
  }
  return null;
}

/** The first variant's `seller`, present only under the Shopify extension. */
function firstSeller(variants: unknown[]): Record<string, unknown> | null {
  for (const v of variants) {
    const seller = ((v ?? {}) as Record<string, unknown>).seller;
    if (seller && typeof seller === 'object') return seller as Record<string, unknown>;
  }
  return null;
}

/** A URL's hostname without a `www.` prefix, or null when it will not parse. */
function hostOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
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
export function mapProduct(raw: unknown) {
  const p = (raw ?? {}) as Record<string, unknown>;
  const range = (p.price_range ?? {}) as Record<string, unknown>;
  const min = price(range.min);
  const max = price(range.max);
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const media = Array.isArray(p.media) ? p.media : [];
  const rating = (p.rating ?? {}) as Record<string, unknown>;
  const url = productUrl(variants);
  // `seller` arrives only under the Shopify extension capability, and it is the
  // authoritative attribution: `id` is the shop GID the `shops` filter takes,
  // so surfacing it is what makes that filter reachable at all. Prefer
  // `seller.url` over `seller.domain` — the latter is the internal myshopify
  // alias (`4iv2q6-x1.myshopify.com`), never a name to show a buyer. Without
  // the capability there is no seller, and the product page URL's hostname is
  // the only attribution on offer.
  const seller = firstSeller(variants);
  const sellerHost = hostOf(nestedStr(seller, 'url'));
  const store = sellerHost ?? hostOf(url);
  const storeUrl = store ? `https://${store}` : null;
  const available = variants.some((v) => {
    const availability = ((v ?? {}) as Record<string, unknown>).availability;
    return ((availability ?? {}) as Record<string, unknown>).available === true;
  });
  return {
    id: typeof p.id === 'string' ? p.id : null,
    title: typeof p.title === 'string' ? p.title : 'Untitled',
    description: nestedStr(p.description, 'plain')?.slice(0, 400) || null,
    url,
    store,
    storeUrl,
    storeId: nestedStr(seller, 'id'),
    storeName: nestedStr(seller, 'name'),
    available,
    priceMin: min.amount,
    priceMax: max.amount,
    currency: min.currency ?? max.currency,
    variantCount: variants.length,
    rating: typeof rating.value === 'number' ? rating.value : null,
    ratingCount: typeof rating.count === 'number' ? rating.count : null,
    imageUrl: nestedStr(media[0], 'url') ?? firstVariantImage(variants),
  };
}

/** The price, or a range, or a plain statement that there isn't one. */
function priceText(product: ReturnType<typeof mapProduct>): string {
  if (product.priceMin === null) return 'price n/a';
  const currency = product.currency ?? '';
  if (product.priceMin === product.priceMax || product.priceMax === null) {
    return `${currency} ${product.priceMin}`;
  }
  return `${currency} ${product.priceMin}–${product.priceMax}`;
}

/** One-line product summary for the human-readable text block. */
export function formatProduct(product: ReturnType<typeof mapProduct>): string {
  const priceLabel = priceText(product);
  const ratingCount = product.ratingCount ? ` (${product.ratingCount})` : '';
  const ratingLabel = product.rating === null ? '' : ` ★${product.rating}${ratingCount}`;
  const stock = product.available ? '' : ' [out of stock]';
  const store = product.store ? ` · ${product.store}` : '';
  return `"${product.title}" — ${priceLabel}${store}${ratingLabel}${stock}\n  ${product.url ?? product.id ?? ''}`;
}

/**
 * Split a UCP result's `messages[]` into the ids it could not resolve and the
 * advisory notes about the request itself.
 *
 * The catalog answers a filter it did not honour with a message rather than an
 * error — an unsupported attribute name is ignored and reported here, and a
 * price band is FX-converted to a USD basis and reports the rate it used as
 * `price_filter_applied`. Dropping these left the caller quoting a filtered set
 * that had not been filtered the way they asked.
 *
 * `not_found` carries both meanings, and `path` is what separates them: an id
 * that resolved to nothing arrives bare, while a filter that was ignored names
 * where it sat (`$.filters.attributes[0]`). Reading every `not_found` as a
 * missing id filed "Attribute X is not supported" under ids, and search — which
 * has no ids to report — dropped it on the floor.
 */
export function mapMessages(result: Record<string, unknown>): {
  notes: string[];
  notFound: string[];
} {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const notes: string[] = [];
  const notFound: string[] = [];
  for (const raw of messages) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const code = typeof m.code === 'string' ? m.code : '';
    const content = typeof m.content === 'string' ? m.content : '';
    const hasRequestPath = typeof m.path === 'string' && m.path.length > 0;
    if (code === 'not_found' && !hasRequestPath) {
      notFound.push(content || 'unknown id');
      continue;
    }
    // A message carrying neither a code nor content says nothing; emitting it
    // would put a bare "Note:" line in the text block and an empty string in
    // `notes[]`.
    const note = [code, content].filter(Boolean).join(': ');
    if (note) notes.push(note);
  }
  return { notes, notFound };
}

/** Map a UCP search result to the tool's structured page shape. */
export function mapSearchPage(result: Record<string, unknown>): {
  totalEstimate: number | null;
  count: number;
  nextCursor: string | null;
  notes: string[];
  products: ReturnType<typeof mapProduct>[];
} {
  const rawProducts = Array.isArray(result.products) ? result.products : [];
  const products = rawProducts.map(mapProduct);
  const pagination = (result.pagination ?? {}) as Record<string, unknown>;
  const { notes } = mapMessages(result);
  return {
    totalEstimate: typeof pagination.total_count === 'number' ? pagination.total_count : null,
    count: products.length,
    nextCursor:
      pagination.has_next_page === true && typeof pagination.cursor === 'string'
        ? pagination.cursor
        : null,
    notes,
    products,
  };
}
