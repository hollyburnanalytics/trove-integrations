/**
 * This catalog's proof that `@ontrove/extend/source`'s HTTP guard refuses everything this
 * catalog needs refused.
 *
 * These do not test catalog code. `http.mjs` used to re-export the SDK's
 * helpers under a local specifier and was deleted — a file with no definitions
 * of its own is a name to look up rather than a thing to read. The tests stay,
 * because the guard is the thing a scraper cannot be wrong about: a source does
 * not choose most of what it fetches, the address comes from a feed or a page,
 * and the SSRF cases below (including the IPv4-mapped-IPv6 form) are the ones
 * an attacker reaches for.
 *
 * The SDK's `http` module was written FROM the file this replaced — the honest
 * bot User-Agent, the hard per-request timeout, the size cap enforced on both
 * the declared Content-Length and the streaming body, the by-hand redirect walk
 * that tells a permanent move from a routine one, and the guard applied to the
 * URL given AND to every hop. Two things changed in the move, both deliberate
 * and both the SDK's call: the User-Agent names the product rather than this
 * catalog (`TroveBot/1.0 (+https://ontrove.sh)`), so an operator who
 * allow-listed the old string sees a new one; and `fetchBytes` returns a plain
 * `Uint8Array` rather than a Node `Buffer`, so the same code runs where there
 * is no `Buffer`.
 *
 * Each helper takes the `fetch` it should use and falls back to the global one
 * READ AT CALL TIME, which is what lets these tests keep stubbing
 * `globalThis.fetch` through `test-fixtures.mjs`.
 */

import { fetchBytes, fetchPage, fetchPageWithMeta, isTooLargeError } from '@ontrove/extend/source';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchMock, setFetch } from './test-fixtures.ts';

/**
 * A Response whose body streams `chunks` without a Content-Length header.
 *
 * @param chunks - The body, one enqueue per chunk.
 * @returns The response.
 */
function streamingResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

describe('http helpers', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetchPage returns the response body as text', async () => {
    setFetch(() => Promise.resolve(new Response('hello world')));
    expect(await fetchPage('https://example.com/page')).toBe('hello world');
  });

  it('fetchPage sends the honest bot User-Agent', async () => {
    setFetch(() => Promise.resolve(new Response('ok')));
    await fetchPage('https://example.com/');
    const [, options] = fetchMock().mock.calls[0] ?? [];
    expect(options?.headers['User-Agent']).toContain('TroveBot');
  });

  it('fetchPage throws on a non-200 response', async () => {
    setFetch(() => Promise.resolve(new Response('', { status: 503 })));
    await expect(fetchPage('https://example.com/down')).rejects.toThrow('HTTP 503');
  });

  it('fetchBytes returns the raw response bytes as a plain Uint8Array', async () => {
    // A `Uint8Array`, not a Node `Buffer`: the seam joins its chunks by hand so
    // the same code runs where there is no `Buffer` at all. Asserted on the
    // type as well as the bytes, because the two compare unequal and a caller
    // reaching for a Buffer method would find it missing.
    const payload = new Uint8Array([37, 80, 68, 70, 0, 255]);
    setFetch(() => Promise.resolve(streamingResponse([payload])));
    const bytes = await fetchBytes('https://example.com/file.pdf');
    expect(bytes).toEqual(payload);
    expect(Buffer.isBuffer(bytes)).toBe(false);
  });

  it('rejects a declared Content-Length above the cap with a too-large error', async () => {
    setFetch(() =>
      Promise.resolve(new Response('tiny', { headers: { 'content-length': '99999999999' } })),
    );
    const error = await fetchPage('https://example.com/big').catch((error_) => error_);
    expect(error.message).toContain('too large');
    expect(isTooLargeError(error)).toBe(true);
  });

  it('rejects a streamed body that exceeds maxBytes with a too-large error', async () => {
    const chunk = new Uint8Array(64);
    setFetch(() => Promise.resolve(streamingResponse([chunk, chunk])));
    const error = await fetchBytes('https://example.com/stream', { maxBytes: 100 }).catch(
      (error_) => error_,
    );
    expect(error.message).toContain('exceeded');
    expect(isTooLargeError(error)).toBe(true);
  });

  it('isTooLargeError is false for ordinary errors', () => {
    expect(isTooLargeError(new Error('HTTP 404'))).toBe(false);
    expect(isTooLargeError()).toBe(false);
  });

  it.each([
    'https://localhost/admin',
    'https://127.0.0.1/metadata',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/internal',
    'https://192.168.1.1/router',
    'https://backend.internal/api',
    'file:///etc/passwd',
    'not a url',
  ])('refuses to fetch %s', async (url) => {
    setFetch();
    expect(fetchBytes(url)).rejects.toThrow();
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

/**
 * A redirect response — what `redirect: 'manual'` surfaces to the caller.
 *
 * @param status - The redirect status.
 * @param location - Where it points; omitted for a headerless redirect.
 * @returns The response.
 */
function redirect(status: number, location?: string): Response {
  return new Response(undefined, { status, headers: location ? { location } : {} });
}

/**
 * Redirect handling is followed by hand so a PERMANENT move can be told from a
 * routine one. Getting this wrong in either direction is costly: miss a 301 and
 * subscriptions rot; treat a 302 as a move and healthy ones get rewritten.
 */
describe('redirects', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('follows a redirect and returns the final body', async () => {
    setFetch((url) =>
      Promise.resolve(
        String(url) === 'https://old.test/f'
          ? redirect(301, 'https://new.test/f')
          : new Response('moved body'),
      ),
    );
    expect(await fetchPage('https://old.test/f')).toBe('moved body');
  });

  it('reports a 301 as a permanent move', async () => {
    setFetch((url) =>
      Promise.resolve(
        String(url) === 'https://old.test/f'
          ? redirect(301, 'https://new.test/f')
          : new Response('body'),
      ),
    );
    const result = await fetchPageWithMeta('https://old.test/f');
    expect(result.movedPermanentlyTo).toBe('https://new.test/f');
  });

  it('reports a 308 as a permanent move', async () => {
    setFetch((url) =>
      Promise.resolve(
        String(url) === 'https://old.test/f'
          ? redirect(308, 'https://new.test/f')
          : new Response('body'),
      ),
    );
    const meta = await fetchPageWithMeta('https://old.test/f');
    expect(meta.movedPermanentlyTo).toBe('https://new.test/f');
  });

  it('does NOT report a 302 as a move', async () => {
    // Routine CDN routing. Treating it as a move would rewrite a healthy
    // subscription to wherever the load balancer pointed today.
    setFetch((url) =>
      Promise.resolve(
        String(url) === 'https://s.test/f'
          ? redirect(302, 'https://edge-7.test/f')
          : new Response('body'),
      ),
    );
    const result = await fetchPageWithMeta('https://s.test/f');
    expect(result.text).toBe('body');
    expect(result.movedPermanentlyTo).toBeUndefined();
  });

  it('does not report 303 or 307 as moves either', async () => {
    for (const status of [303, 307]) {
      setFetch((url) =>
        Promise.resolve(
          String(url) === 'https://s.test/f'
            ? redirect(status, 'https://other.test/f')
            : new Response('body'),
        ),
      );
      const meta = await fetchPageWithMeta('https://s.test/f');
      expect(meta.movedPermanentlyTo).toBeUndefined();
    }
  });

  it('stops counting at the first non-permanent hop', async () => {
    // 301 → 302: the resource permanently moved ONCE. Following further is
    // fine, but the new home is the 302's origin, not past it.
    const chain: Record<string, Response> = {
      'https://a.test/f': redirect(301, 'https://b.test/f'),
      'https://b.test/f': redirect(302, 'https://c.test/f'),
    };
    setFetch((url) => Promise.resolve(chain[String(url)] ?? new Response('body')));
    const meta = await fetchPageWithMeta('https://a.test/f');
    expect(meta.movedPermanentlyTo).toBe('https://b.test/f');
  });

  it('follows a chain of permanent hops to its end', async () => {
    const chain: Record<string, Response> = {
      'https://a.test/f': redirect(301, 'https://b.test/f'),
      'https://b.test/f': redirect(308, 'https://c.test/f'),
    };
    setFetch((url) => Promise.resolve(chain[String(url)] ?? new Response('body')));
    const meta = await fetchPageWithMeta('https://a.test/f');
    expect(meta.movedPermanentlyTo).toBe('https://c.test/f');
  });

  it('re-applies the SSRF guard to every hop', async () => {
    // A redirect chain is the classic way past a guard applied only to the URL
    // the caller supplied.
    setFetch(() => Promise.resolve(redirect(301, 'https://169.254.169.254/latest/meta-data/')));
    await expect(fetchPage('https://evil.test/f')).rejects.toThrow(/private or loopback/);
  });

  it('refuses a hop to a non-HTTP scheme', async () => {
    setFetch(() => Promise.resolve(redirect(301, 'file:///etc/passwd')));
    await expect(fetchPage('https://evil.test/f')).rejects.toThrow(/non-HTTP/);
  });

  it('resolves a relative Location against the current URL', async () => {
    const seen: string[] = [];
    setFetch((url) => {
      seen.push(String(url));
      return Promise.resolve(
        seen.length === 1 ? redirect(301, '/moved/f.xml') : new Response('body'),
      );
    });
    await fetchPage('https://s.test/deep/f.xml');
    expect(seen[1]).toBe('https://s.test/moved/f.xml');
  });

  it('gives up rather than looping forever', async () => {
    setFetch((url) =>
      Promise.resolve(
        redirect(301, String(url) === 'https://a.test/f' ? 'https://b.test/f' : 'https://a.test/f'),
      ),
    );
    await expect(fetchPage('https://a.test/f')).rejects.toThrow(/Too many redirects/);
  });

  it('fails clearly on a redirect with no Location', async () => {
    setFetch(() => Promise.resolve(redirect(301)));
    await expect(fetchPage('https://s.test/f')).rejects.toThrow(/no Location/);
  });

  it('reports no move for an ordinary 200', async () => {
    setFetch(() => Promise.resolve(new Response('body')));
    const meta = await fetchPageWithMeta('https://s.test/f');
    expect(meta.movedPermanentlyTo).toBeUndefined();
  });

  it('still returns bytes through a redirect for fetchBytes', async () => {
    setFetch((url) =>
      Promise.resolve(
        String(url) === 'https://old.test/f.pdf'
          ? redirect(301, 'https://new.test/f.pdf')
          : new Response(new Uint8Array([1, 2, 3])),
      ),
    );
    expect([...(await fetchBytes('https://old.test/f.pdf'))]).toEqual([1, 2, 3]);
  });
});

describe('the IPv4-mapped IPv6 bypass', () => {
  // `new URL()` normalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1`. The dotted
  // quad the guard checks is gone by the time it looks, so every one of these
  // was permitted until the `::` prefix was refused outright.
  it.each([
    'https://[::ffff:127.0.0.1]/mapped-loopback',
    'https://[::ffff:10.0.0.1]/mapped-private',
    'https://[::ffff:169.254.169.254]/mapped-link-local',
    'https://[::127.0.0.1]/compatible-loopback',
    'https://[::]/unspecified',
  ])('refuses %s', async (url) => {
    // Asserted through `fetchPage`, which is how a source reaches the guard,
    // and proves the request is refused before any fetch is attempted.
    const mock = setFetch();
    await expect(fetchPage(url)).rejects.toThrow(/private or loopback/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('still permits a real public address', async () => {
    const mock = setFetch(() => Promise.resolve(new Response('ok')));
    await expect(fetchPage('https://[2606:4700:4700::1111]/dns')).resolves.toBe('ok');
    expect(mock).toHaveBeenCalled();
  });
});
