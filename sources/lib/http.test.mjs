import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchMock, setFetch } from './feed-fixtures.mjs';
import { fetchBytes, fetchPage, fetchPageWithMeta, isTooLargeError } from './http.mjs';

/**
 * A Response whose body streams `chunks` without a Content-Length header.
 *
 * @param {Uint8Array[]} chunks - The body, one enqueue per chunk.
 * @returns {Response} The response.
 */
function streamingResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

describe('http helpers', () => {
  /** @type {typeof fetch} */
  let realFetch;
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

  it('fetchBytes returns the raw response bytes', async () => {
    const payload = new Uint8Array([37, 80, 68, 70, 0, 255]);
    setFetch(() => Promise.resolve(streamingResponse([payload])));
    expect(await fetchBytes('https://example.com/file.pdf')).toEqual(Buffer.from(payload));
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
 * @param {number} status - The redirect status.
 * @param {string} [location] - Where it points; omitted for a headerless redirect.
 * @returns {Response} The response.
 */
function redirect(status, location) {
  return new Response(undefined, { status, headers: location ? { location } : {} });
}

/**
 * Redirect handling is followed by hand so a PERMANENT move can be told from a
 * routine one. Getting this wrong in either direction is costly: miss a 301 and
 * subscriptions rot; treat a 302 as a move and healthy ones get rewritten.
 */
describe('redirects', () => {
  /** @type {typeof fetch} */
  let realFetch;
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
    /** @type {Record<string, Response>} */
    const chain = {
      'https://a.test/f': redirect(301, 'https://b.test/f'),
      'https://b.test/f': redirect(302, 'https://c.test/f'),
    };
    setFetch((url) => Promise.resolve(chain[String(url)] ?? new Response('body')));
    const meta = await fetchPageWithMeta('https://a.test/f');
    expect(meta.movedPermanentlyTo).toBe('https://b.test/f');
  });

  it('follows a chain of permanent hops to its end', async () => {
    /** @type {Record<string, Response>} */
    const chain = {
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
    /** @type {string[]} */
    const seen = [];
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
