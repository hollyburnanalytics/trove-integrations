/**
 * UCP product mapping for the Shopify Global Catalog toolkit: raw catalog
 * products (see the probes in the PR) to the compact tool-facing summaries.
 * Split from server.ts purely for file-size hygiene.
 */

/** A UCP `Price` (`amount` in minor units + ISO currency) as a decimal, or null. */
export function price(obj: unknown): { amount: number | null; currency: string | null } {
  const o = (obj ?? {}) as Record<string, unknown>;
  const minor = typeof o.amount === 'number' ? o.amount : null;
  const currency = typeof o.currency === 'string' ? o.currency : null;
  // UCP amounts are minor units; every currency the catalog serves today uses
  // exponent 2. Presented as major units for readability.
  return { amount: minor !== null ? minor / 100 : null, currency };
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
      return u.toString();
    } catch {
      return raw;
    }
  }
  return null;
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
  // The catalog carries no seller object; the product page URL lives on each
  // variant, and its hostname is the storefront — the honest attribution the
  // catalog gives us. Tracking params are stripped, variant selection kept.
  const url = productUrl(variants);
  const store = url ? new URL(url).hostname.replace(/^www\./, '') : null;
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

/** One-line product summary for the human-readable text block. */
export function formatProduct(product: ReturnType<typeof mapProduct>): string {
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
  const stock = product.available ? '' : ' [out of stock]';
  return `"${product.title}" — ${priceLabel}${product.store ? ` · ${product.store}` : ''}${ratingLabel}${stock}\n  ${product.url ?? product.id ?? ''}`;
}
