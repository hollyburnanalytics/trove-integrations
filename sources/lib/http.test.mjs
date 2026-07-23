import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fetchBytes, fetchPage, isTooLargeError } from './http.mjs';

/** A Response whose body streams `chunks` without a Content-Length header. */
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
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetchPage returns the response body as text', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('hello world')));
    expect(await fetchPage('https://example.com/page')).toBe('hello world');
  });

  it('fetchPage sends the honest bot User-Agent', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('ok')));
    await fetchPage('https://example.com/');
    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers['User-Agent']).toContain('TroveBot');
  });

  it('fetchPage throws on a non-200 response', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('', { status: 503 })));
    expect(fetchPage('https://example.com/down')).rejects.toThrow('HTTP 503');
  });

  it('fetchBytes returns the raw response bytes', async () => {
    const payload = new Uint8Array([37, 80, 68, 70, 0, 255]);
    globalThis.fetch = mock(() => Promise.resolve(streamingResponse([payload])));
    expect(await fetchBytes('https://example.com/file.pdf')).toEqual(Buffer.from(payload));
  });

  it('rejects a declared Content-Length above the cap with a too-large error', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('tiny', { headers: { 'content-length': '99999999999' } })),
    );
    const error = await fetchPage('https://example.com/big').catch((error_) => error_);
    expect(error.message).toContain('too large');
    expect(isTooLargeError(error)).toBe(true);
  });

  it('rejects a streamed body that exceeds maxBytes with a too-large error', async () => {
    const chunk = new Uint8Array(64);
    globalThis.fetch = mock(() => Promise.resolve(streamingResponse([chunk, chunk])));
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
    globalThis.fetch = mock();
    expect(fetchBytes(url)).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
