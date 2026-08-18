/**
 * The guarded HTTP seam for source adapters — re-exported from `@ontrove/sdk`.
 *
 * The SDK's `http` module was written from THIS file: the honest bot
 * User-Agent, the hard per-request timeout, the size cap enforced on both the
 * declared Content-Length and the streaming body, the by-hand redirect walk
 * that tells a permanent move from a routine one, and the SSRF guard applied to
 * the URL given AND to every hop. Keeping the specifier `sources/lib/http.mjs`
 * means `feeds.mjs` and the adapters go on importing what they always did while
 * one copy of that guard serves every catalog and every runtime.
 *
 * `sources/lib/http.test.mjs` still runs against these exports — including the
 * IPv4-mapped-IPv6 bypass cases — and that is the point of it: it is this
 * catalog's proof that the SDK's guard refuses everything this catalog needs
 * refused.
 *
 * Two differences from the code that was here, both deliberate and both the
 * SDK's call:
 *
 * 1. **The User-Agent changed** from `TroveBot/0.1 (+…/trove-integrations)` to
 *    `TroveBot/1.0 (+https://ontrove.sh)`. It still identifies the traffic
 *    honestly, but it now names the product rather than one of its catalogs,
 *    and a site operator who had allow- or block-listed the old string will see
 *    a new one.
 * 2. **`fetchBytes` returns a plain `Uint8Array`** rather than a Node `Buffer`,
 *    so the same code runs in a runtime that has no `Buffer`. Nothing in this
 *    catalog fetches bytes today; a future caller wanting `Buffer` methods must
 *    wrap it itself.
 *
 * Each helper takes the `fetch` it should use and falls back to the global one
 * READ AT CALL TIME — which is what lets these tests keep stubbing
 * `globalThis.fetch` through `test-fixtures.mjs`.
 *
 * @module
 */

export {
  assertPublicHttpUrl,
  FETCH_TIMEOUT_MS,
  fetchBytes,
  fetchPage,
  fetchPageWithMeta,
  HttpStatusError,
  isTooLargeError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  TROVE_USER_AGENT,
} from '@ontrove/sdk';
