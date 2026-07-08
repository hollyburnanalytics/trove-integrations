import { mock } from 'bun:test';

/**
 * Test helpers for the hosted MCP servers.
 *
 * A built server (the `defineMcpServer(...)` default export) resolves egress
 * through `globalThis.fetch` unless a `fetchImpl` is injected at definition
 * time. These helpers swap in a mocked `fetch`, drive a tool through the real
 * SDK request path (`server.handle`), and restore the original `fetch` after.
 * No network is ever touched — every test must mock `fetch`.
 */

/**
 * Build a mocked `fetch`. The responder receives `(url, init)` and returns
 * either a `Response`, or a plain object `{ status?, json?, text?, headers? }`
 * that is wrapped into one. A bare object (no responder fn) replies to every
 * request with that same shape.
 *
 * @param {object|Function} responder - A `(url, init) => spec | Response`, or a literal spec.
 * @returns {import('bun:test').Mock} The mocked fetch.
 */
export function fetchMock(responder) {
  return mock((url, init) => {
    const target = typeof url === 'string' ? url : String(url);
    const spec = typeof responder === 'function' ? responder(target, init) : responder;
    if (spec instanceof Response) return Promise.resolve(spec);
    const { status = 200, json, text, headers } = spec ?? {};
    const body = json === undefined ? (text ?? '') : JSON.stringify(json);
    return Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } }),
    );
  });
}

/**
 * Invoke one tool on a built server with a mocked `fetch`, returning the
 * normalized result (`{ ok: true, result }` or `{ ok: false, error, code, retryable }`).
 *
 * For servers that read secrets, the responder also sees the SDK's secret
 * callback to `${callbackBase}/internal/secret` — branch on the URL and reply
 * `{ json: { value: '<secret>' } }` to satisfy `ctx.requireSecret`.
 *
 * @param {object} server - The server's default export (from `defineMcpServer`).
 * @param {string} tool - The tool name to invoke.
 * @param {object} args - The tool arguments.
 * @param {object|Function} [responder] - A `fetchMock` responder (omit for arg-validation tests).
 * @param {string[]} [scopes] - Granted scopes for this call (e.g. `['trove:ingest']` to enable `ctx.trove`).
 * @returns {Promise<object>} The `McpToolCallResult`.
 */
export async function callTool(server, tool, arguments_, responder, scopes = []) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchMock(
    responder ??
      (() => {
        throw new Error('unexpected fetch in a no-network test');
      }),
  );
  try {
    return await server.handle({
      tool,
      args: arguments_,
      ctxToken: 'test-ctx-token',
      callbackBase: 'https://callback.test',
      userId: 'test-user',
      scopes,
    });
  } finally {
    globalThis.fetch = saved;
  }
}

/**
 * Reply to the SDK secret callback with `value`, delegating every other request
 * to `responder`. Use for servers that call `ctx.requireSecret`.
 *
 * @param {string} value - The secret value to return.
 * @param {object|Function} responder - The responder for non-secret requests.
 * @returns {Function} A `fetchMock` responder.
 */
export function withSecret(value, responder) {
  return (url, init) => {
    if (url.includes('/internal/secret')) return { json: { value } };
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
}
