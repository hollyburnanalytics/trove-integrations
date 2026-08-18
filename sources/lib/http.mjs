/**
 * HTTP fetch for feed source adapters: an honest bot User-Agent, a hard
 * per-request timeout, a response-size cap, and an SSRF guard that rejects
 * non-public hosts. Feed `<link>` targets come from the publisher, so every
 * fetch target is treated as untrusted.
 */

const HEADERS = {
  // Descriptive, attributable User-Agent that identifies this client honestly.
  'User-Agent': 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

// Per-request ceiling. Without it a single slow/hung host stalls an entire sync
// run for minutes (until the host process is killed). A bounded request fails
// fast and is retried next run.
const FETCH_TIMEOUT_MS = 20_000;

/**
 * IPv4/IPv6 hosts in private, loopback, or link-local ranges (SSRF guard).
 *
 * @param {string} host - The hostname, lowercased and unbracketed.
 * @returns {boolean} True when it must not be fetched.
 */
function isPrivateHost(host) {
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  // Every IPv6 address beginning `::` is refused, and the reason is a bypass
  // rather than tidiness: `https://[::ffff:127.0.0.1]/` has its hostname
  // NORMALIZED by `new URL()` to `::ffff:7f00:1`, which is not `::1`, does not
  // start with `fe80:`/`fc`/`fd`, and — having no dots left — never reaches the
  // dotted-quad test below. It was therefore allowed. The same trick carries
  // `::ffff:10.0.0.1`, `::127.0.0.1` and the unspecified `::`. Global unicast
  // is 2000::/3, so nothing reachable on the public web starts this way and
  // refusing the whole prefix costs nothing.
  if (host.startsWith('::')) return true;
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 255)) return false;
  // Defaults that match nothing below: the length check above already
  // guarantees four octets, and destructuring cannot see that.
  const [first = -1, second = -1] = numbers;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) || // link-local, incl. the 169.254.169.254 metadata IP
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) // CGNAT
  );
}

/**
 * Guard a URL before fetching. Feed `<link>` targets come from the publisher,
 * not us, so a hostile or compromised feed could aim them at localhost, a cloud
 * metadata endpoint, or an internal IP. We only ever want public web pages, so
 * require http(s) and reject private/loopback/link-local hosts.
 *
 * @param {string} target - The address about to be fetched.
 * @returns {void} Nothing; it throws when the target is not a public web page.
 */
function assertPublicHttpUrl(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`Invalid URL: ${target}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing non-HTTP(S) URL: ${target}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateHost(host)
  ) {
    throw new Error(`Refusing to fetch private or loopback host: ${host}`);
  }
}

/**
 * Marker for a response rejected by the size cap — a permanent condition (the
 * resource is simply too big), unlike a timeout or connection error that may
 * succeed on retry. Callers branch on {@link isTooLargeError}.
 */
const TOO_LARGE_CODE = 'ERESPONSETOOLARGE';

/**
 * Whether an error from {@link fetchPage}/{@link fetchBytes} was a size-cap rejection.
 *
 * @param {unknown} [error] - Whatever was thrown.
 * @returns {boolean} True for the permanent "too large" condition.
 */
export function isTooLargeError(error) {
  return /** @type {{ code?: string }} */ (error)?.code === TOO_LARGE_CODE;
}

/** @param {string} message @returns {Error & { code: string }} */
function tooLargeError(message) {
  return Object.assign(new Error(message), { code: TOO_LARGE_CODE });
}

/** Redirect hops followed before giving up. Feeds need far fewer than a browser. */
const MAX_REDIRECTS = 5;

/** Statuses that mean "this resource has permanently moved". */
const PERMANENT_REDIRECTS = new Set([301, 308]);

/** Statuses that are a redirect at all. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Follow redirects by hand, so a **permanent** one can be told from a routine
 * one, and so every hop is re-checked against the SSRF guard.
 *
 * `fetch` follows redirects transparently and reports only the final URL, which
 * cannot distinguish 301 (the resource moved; update your records) from 302 (a
 * CDN routing you somewhere today). Treating the latter as a move would corrupt
 * healthy subscriptions, so the distinction has to be made here.
 *
 * The permanent target is the URL reached by the **leading run** of permanent
 * hops. A 301 followed by a 302 has permanently moved once — to the 302's
 * origin, not past it.
 *
 * @param {string} url - The starting address.
 * @param {AbortSignal} signal
 * @param {Record<string, string>} [extraHeaders] - Merged over the defaults.
 * @returns {Promise<{response: Response, url: string, movedPermanentlyTo?: string}>}
 */
async function fetchFollowing(url, signal, extraHeaders) {
  // Merged over the defaults rather than replacing them, so a caller adding one
  // header does not silently drop the honest User-Agent or Accept.
  const headers = extraHeaders ? { ...HEADERS, ...extraHeaders } : HEADERS;
  let current = url;
  let isPermanentSoFar = true;
  /** @type {string | undefined} */
  let movedPermanentlyTo;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { headers, signal, redirect: 'manual' });
    if (!REDIRECTS.has(response.status)) {
      return { response, url: current, ...(movedPermanentlyTo && { movedPermanentlyTo }) };
    }

    const location = response.headers.get('location');
    if (!location) throw new Error(`HTTP ${response.status} with no Location fetching ${current}`);

    let next;
    try {
      next = new URL(location, current).href;
    } catch {
      throw new Error(`HTTP ${response.status} with an unusable Location fetching ${current}`);
    }
    // Every hop is a fresh fetch target chosen by the upstream, so every hop is
    // re-checked. A redirect chain is the classic way past a guard applied only
    // to the URL a caller supplied.
    assertPublicHttpUrl(next);

    if (isPermanentSoFar && PERMANENT_REDIRECTS.has(response.status)) movedPermanentlyTo = next;
    else isPermanentSoFar = false;

    current = next;
  }
  throw new Error(`Too many redirects (${MAX_REDIRECTS}) fetching ${url}`);
}

/**
 * Fetch a URL and return the raw response bytes, enforcing `maxBytes` both on
 * the declared Content-Length and while streaming the body.
 *
 * @param {string} url
 * @param {number} maxBytes
 * @param {AbortSignal} signal
 * @param {Record<string, string>} [headers] - Extra headers, merged over the defaults.
 * @returns {Promise<{bytes: Uint8Array, movedPermanentlyTo?: string}>}
 */
async function fetchCappedBytes(url, maxBytes, signal, headers) {
  const { response, movedPermanentlyTo } = await fetchFollowing(url, signal, headers);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw tooLargeError(`Response too large (${contentLength} bytes) for ${url}`);
  }

  // A 200 with no body at all is not something to stream: `getReader()` on it
  // throws a bare "cannot read properties of null", naming neither the URL nor
  // the condition.
  if (!response.body) throw new Error(`HTTP ${response.status} with no body fetching ${url}`);

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw tooLargeError(`Response exceeded ${maxBytes} bytes for ${url}`);
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), movedPermanentlyTo };
}

/**
 * Fetch a URL with our honest bot UA, a hard timeout, and a response-size cap.
 * Rejects non-public hosts (SSRF guard), throws on non-200. Returns body text.
 *
 * `maxBytes` raises the cap for document classes that are legitimately larger
 * than an article feed — a podcast feed carries every episode it has ever
 * published, so The Daily's is 17.6 MB against the 10 MB default. A rejection
 * throws an error {@link isTooLargeError} recognizes, so callers can treat it
 * as permanent rather than retry it forever.
 *
 * @param {string} url - The address to fetch.
 * @param {{ maxBytes?: number, headers?: Record<string, string> }} [options] - Cap
 *   override and extra request headers.
 * @returns {Promise<string>} The decoded body.
 */
export async function fetchPage(url, options = {}) {
  const { text } = await fetchPageWithMeta(url, options);
  return text;
}

/**
 * {@link fetchPage} plus what the fetch learned about the address itself.
 *
 * `movedPermanentlyTo` is set only when the chain began with 301/308 — the
 * resource announcing a new home, as opposed to a 302 routing this request
 * somewhere today. Callers that track where a subscription lives read this;
 * everyone else uses {@link fetchPage} and never sees it.
 *
 * @param {string} url
 * @param {{ maxBytes?: number, headers?: Record<string, string> }} [options]
 * @returns {Promise<{text: string, movedPermanentlyTo?: string}>}
 */
export async function fetchPageWithMeta(url, { maxBytes = MAX_RESPONSE_BYTES, headers } = {}) {
  assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { bytes, movedPermanentlyTo } = await fetchCappedBytes(
      url,
      maxBytes,
      controller.signal,
      headers,
    );
    return {
      text: new TextDecoder().decode(bytes),
      ...(movedPermanentlyTo && { movedPermanentlyTo }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Binary twin of {@link fetchPage}: same SSRF guard, honest UA, timeout, and
 * streamed size cap, but returns the raw bytes — for document downloads (PDFs)
 * where text-decoding would corrupt the payload. `maxBytes` lets a source raise
 * the cap for known-large documents; a cap rejection throws an error that
 * {@link isTooLargeError} recognizes, so callers can treat it as permanent
 * (skip the document) rather than transient (retry next run).
 *
 * @param {string} url
 * @param {{ maxBytes?: number, headers?: Record<string, string> }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytes(url, { maxBytes = MAX_RESPONSE_BYTES, headers } = {}) {
  assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { bytes } = await fetchCappedBytes(url, maxBytes, controller.signal, headers);
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
