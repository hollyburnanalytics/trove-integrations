import { z } from '@ontrove/extend/toolkit';

/**
 * Input vocabulary shared by the three catalog tools.
 */

/**
 * Shared context input: buyer signals for relevance and localization. Mapped
 * onto the UCP wire names by `buildContext` — `country` travels as
 * `address_country`, which is what actually localizes the prices.
 */
export const contextInput = z
  .object({
    country: z.string().length(2).optional().describe('ISO 3166 country, e.g. "CA".'),
    language: z.string().optional().describe('BCP-47 language, e.g. "en".'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency, e.g. "CAD".'),
  })
  .optional()
  .describe('Buyer locale signals for relevance, localization, and pricing.');

/** A Shopify GID, the only id shape upstream accepts as a `like` reference. */
export const SHOPIFY_GID = /^gid:\/\/shopify\//;

/** A Shopify shop GID, the only form the `shops` filter matches. */
export const SHOP_GID = /^gid:\/\/shopify\/Shop\/\w+$/;

/** A Shopify taxonomy category GID, the only form the `categories` filter matches. */
export const TAXONOMY_GID = /^gid:\/\/shopify\/TaxonomyCategory\/[\w-]+$/;
