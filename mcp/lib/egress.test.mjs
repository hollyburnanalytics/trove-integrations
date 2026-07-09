import { describe, expect, it } from 'bun:test';
import { createEgressClient } from './egress.ts';

/** A fake ToolContext whose fetch is driven by a queue of responders. */
function fakeContext(responders) {
  const calls = [];
  return {
    calls,
    log() {},
    fetch(url, init) {
      calls.push({ url, init });
      const responder = responders.length > 1 ? responders.shift() : responders[0];
      const spec = typeof responder === 'function' ? responder(url, init) : responder;
      if (spec instanceof Error) return Promise.reject(spec);
      // Hand out a clone: a Response body is single-use, but a responder may
      // serve several requests.
      return Promise.resolve(spec.clone());
    },
  };
}

const ok = (body, headers) => new Response(body, { status: 200, headers });
const status = (code, headers) => new Response('', { status: code, headers });

const client = (over = {}) =>
  createEgressClient({ service: 'TestSvc', throttleMs: 0, backoffBaseMs: 1, ...over });

describe('egress client', () => {
  it('returns 2xx bodies and passes static + accept headers', async () => {
    const c = createEgressClient({
      service: 'TestSvc',
      throttleMs: 0,
      headers: { 'user-agent': 'ua' },
    });
    const context = fakeContext([ok('hello')]);
    const result = await c.fetch(context, 'https://x.test/a', { accept: 'text/plain' });
    expect(result).toEqual({ status: 200, body: 'hello' });
    expect(context.calls[0].init.headers).toEqual({ 'user-agent': 'ua', accept: 'text/plain' });
  });

  it('passes 400/404 through as empty results for callers to map', async () => {
    const c = client();
    expect(await c.fetch(fakeContext([status(404)]), 'https://x.test/n')).toEqual({
      status: 404,
      body: '',
    });
    expect(await c.fetch(fakeContext([status(400)]), 'https://x.test/b')).toEqual({
      status: 400,
      body: '',
    });
  });

  it('throws non-retryable on an unexpected status', async () => {
    const c = client();
    await expect(c.fetch(fakeContext([status(418)]), 'https://x.test/t')).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('retries a transient 5xx and recovers', async () => {
    const c = client();
    const context = fakeContext([status(503), status(503), ok('recovered')]);
    const result = await c.fetch(context, 'https://x.test/r');
    expect(result.body).toBe('recovered');
    expect(context.calls).toHaveLength(3);
  });

  it('gives up on a persistent 5xx with a retryable error', async () => {
    const c = client();
    await expect(c.fetch(fakeContext([status(500)]), 'https://x.test/d')).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('honors a numeric Retry-After on rate limits, then surfaces retryable', async () => {
    const c = client();
    const context = fakeContext([status(429, { 'retry-after': '0' }), ok('after limit')]);
    const limited = await c.fetch(context, 'https://x.test/l');
    expect(limited.body).toBe('after limit');
    const rejected = c.fetch(
      fakeContext([status(429, { 'retry-after': '2' })]),
      'https://x.test/l2',
    );
    await expect(rejected).rejects.toMatchObject({ retryable: true });
    await expect(rejected).rejects.toThrow(/rate-limiting/i);
  });

  it('parses an HTTP-date Retry-After', async () => {
    const c = client();
    const soon = new Date(Date.now() + 5).toUTCString();
    const context = fakeContext([status(429, { 'retry-after': soon }), ok('dated')]);
    const dated = await c.fetch(context, 'https://x.test/date');
    expect(dated.body).toBe('dated');
  });

  it('treats configured extra statuses (e.g. 403) as rate limits', async () => {
    const c = client({ rateLimitStatuses: [403] });
    const context = fakeContext([status(403), ok('after 403')]);
    const after403 = await c.fetch(context, 'https://x.test/f');
    expect(after403.body).toBe('after 403');
  });

  it('retries network errors and recovers', async () => {
    const c = client();
    const context = fakeContext([new Error('boom'), ok('net ok')]);
    const netOk = await c.fetch(context, 'https://x.test/net');
    expect(netOk.body).toBe('net ok');
  });

  it('gives up on persistent network errors with a retryable error', async () => {
    const c = client();
    await expect(
      c.fetch(fakeContext([new Error('down')]), 'https://x.test/down'),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('serves repeats from cache (200s only) and respects cacheable:false', async () => {
    const c = client({ cache: { ttlMs: 60_000, maxEntries: 4, maxEntryBytes: 1024 } });
    const context = fakeContext([ok('cached')]);
    await c.fetch(context, 'https://x.test/c');
    await c.fetch(context, 'https://x.test/c');
    expect(context.calls).toHaveLength(1);
    await c.fetch(context, 'https://x.test/c', { cacheable: false });
    expect(context.calls).toHaveLength(2);
  });

  it('expires cache entries past their TTL', async () => {
    const c = client({ cache: { ttlMs: -1, maxEntries: 4, maxEntryBytes: 1024 } });
    const context = fakeContext([ok('v1')]);
    await c.fetch(context, 'https://x.test/ttl');
    await c.fetch(context, 'https://x.test/ttl');
    expect(context.calls).toHaveLength(2); // already expired → refetched
  });

  it('evicts oldest entries past maxEntries and maxTotalBytes', async () => {
    const c = client({
      cache: { ttlMs: 60_000, maxEntries: 2, maxEntryBytes: 1024, maxTotalBytes: 10 },
    });
    const context = fakeContext([(url) => ok(url.endsWith('1') ? '123456' : '789012')]);
    await c.fetch(context, 'https://x.test/1'); // 6 bytes cached
    await c.fetch(context, 'https://x.test/2'); // 12 total > 10 → /1 evicted
    await c.fetch(context, 'https://x.test/1'); // refetched
    expect(context.calls).toHaveLength(3);
  });

  it('skips caching bodies over the per-entry cap', async () => {
    const c = client({ cache: { ttlMs: 60_000, maxEntries: 4, maxEntryBytes: 3 } });
    const context = fakeContext([ok('too big')]);
    await c.fetch(context, 'https://x.test/big');
    await c.fetch(context, 'https://x.test/big');
    expect(context.calls).toHaveLength(2);
  });

  it('staggers concurrent requests through the throttle', async () => {
    const c = client({ throttleMs: 5, forceThrottleInTests: true });
    const context = fakeContext([ok('a')]);
    const started = Date.now();
    await Promise.all([
      c.fetch(context, 'https://x.test/t1', { cacheable: false }),
      c.fetch(context, 'https://x.test/t2', { cacheable: false }),
      c.fetch(context, 'https://x.test/t3', { cacheable: false }),
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8);
    expect(context.calls).toHaveLength(3);
  });
});
