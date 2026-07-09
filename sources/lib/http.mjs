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

/** IPv4/IPv6 hosts in private, loopback, or link-local ranges (SSRF guard). */
function isPrivateHost(host) {
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map(Number);
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = numbers;
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
 * Fetch a URL with our honest bot UA, a hard timeout, and a response-size cap.
 * Rejects non-public hosts (SSRF guard), throws on non-200. Returns body text.
 */
export async function fetchPage(url) {
  assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large (${contentLength} bytes) for ${url}`);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        reader.cancel();
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}
