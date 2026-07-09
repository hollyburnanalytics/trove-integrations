import { describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

/**
 * Transport-level error mapping (`xGet` → `mapXHttpError`/`parseXError` in
 * `client.ts`), driven through `resolve_user` (a single `/2/users/by/username`
 * read) with `fetch` mocked to return each X error shape. Every case asserts the
 * mapped tool error and its retryability; the network is never touched.
 */

/** A responder that satisfies the bearer-token secret, then returns `spec` for the API read. */
function apiError(spec) {
  return withSecret('bearer-xyz', () => spec);
}

describe('x client error mapping', () => {
  it('maps 404 with an errors[].detail reason to a non-retryable not-found', async () => {
    const result = await callTool(
      server,
      'resolve_user',
      { username: 'ghost' },
      apiError({ status: 404, json: { errors: [{ detail: 'Could not find user' }] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('X resource not found');
    expect(result.error).toContain('Could not find user');
    expect(result.retryable).toBe(false);
  });

  it('maps 429 to a retryable rate-limit error', async () => {
    const result = await callTool(
      server,
      'resolve_user',
      { username: 'elonmusk' },
      apiError({ status: 429, json: { title: 'Too Many Requests' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rate limit');
    expect(result.retryable).toBe(true);
  });

  it('maps a non-JSON error body to a non-retryable generic rejection', async () => {
    const result = await callTool(
      server,
      'resolve_user',
      { username: 'elonmusk' },
      apiError({
        status: 400,
        text: '<html>Bad Request</html>',
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('X rejected the request');
    expect(result.retryable).toBe(false);
  });

  it('maps a 4xx with an empty JSON body to a reasonless rejection', async () => {
    const result = await callTool(
      server,
      'resolve_user',
      { username: 'elonmusk' },
      apiError({ status: 422, json: {} }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('X rejected the request');
    expect(result.retryable).toBe(false);
  });
});
