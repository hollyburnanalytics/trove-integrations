import type { ToolContext } from '@ontrove/mcp';
import { ToolError } from '@ontrove/mcp';

/**
 * Shared Jonas Premier plumbing for the jonas-premier server modules: the
 * OAuth2 password-grant mint and per-user token cache, the authenticated GET
 * helper with a single retry on 401, query-string building, and the
 * `{ Data, Message, Code, Summary }` envelope unwrapping every tool relies on.
 *
 * Auth is an OAuth2 *password* grant against `POST /Authenticate` with the
 * fixed public client id `Premier.ExternalAPI` plus the username/password of an
 * **API user created inside the customer's Premier tenant** — the vendor's
 * documented API access pattern (the credential identifies the tenant; the
 * host is shared). The SDK's declarative `auth` block only speaks
 * client-credentials, so the mint is hand-rolled below: secrets via
 * `ctx.requireSecret('JONAS_USERNAME'/'JONAS_PASSWORD')`, token cached
 * per-user (never per-server — one tenant's token must not serve another),
 * re-minted once on a 401. Set the secrets with
 * `trove secret set jonas-premier JONAS_USERNAME …` (and …PASSWORD…).
 */

/** Base host for the Premier External API (shared across tenants). */
const BASE_URL = 'https://api.jonas-premier.com';

/** Fixed public client id for the password grant (per the vendor's API docs). */
const AUTH_CLIENT_ID = 'Premier.ExternalAPI';

/** Fallback token lifetime when the mint response omits `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** Refresh this long before nominal expiry so in-flight calls never race it. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * Per-user token cache. Premier credentials are per-tenant secrets, so the
 * cache key MUST be the calling user — a server-wide token would let one
 * tenant's calls ride on another's session (same hazard the SDK notes for its
 * own client-credentials cache).
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Single-flight guards so concurrent calls per user share one mint. */
const mintsInFlight = new Map<string, Promise<string>>();

/** Test hook: drop all cached tokens (module state survives across calls). */
export function __resetTokenCache(): void {
  tokenCache.clear();
  mintsInFlight.clear();
}

/** POST the password grant and cache the bearer for this user. */
async function mintToken(ctx: ToolContext): Promise<string> {
  const username = await ctx.requireSecret('JONAS_USERNAME');
  const password = await ctx.requireSecret('JONAS_PASSWORD');
  const form = new URLSearchParams({
    grant_type: 'password',
    client_id: AUTH_CLIENT_ID,
    username,
    password,
  });
  const res = await ctx.fetch(`${BASE_URL}/Authenticate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ToolError(
        'Premier rejected the API credentials. Check JONAS_USERNAME/JONAS_PASSWORD — they must ' +
          'belong to an API user created in the Premier tenant (Settings → API users).',
        { retryable: false },
      );
    }
    throw new ToolError(`Premier auth endpoint returned ${res.status}.`, {
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ToolError('Premier auth returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const token = obj.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new ToolError('Premier auth response carried no access token; try again shortly.', {
      retryable: true,
    });
  }
  const ttl = typeof obj.expires_in === 'number' ? obj.expires_in : DEFAULT_TOKEN_TTL_SECONDS;
  tokenCache.set(ctx.userId, {
    token,
    expiresAt: Date.now() + ttl * 1000 - TOKEN_EXPIRY_BUFFER_MS,
  });
  return token;
}

/** Return a live bearer for this user, minting (single-flight) when needed. */
async function getToken(ctx: ToolContext): Promise<string> {
  const cached = tokenCache.get(ctx.userId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  let mint = mintsInFlight.get(ctx.userId);
  if (!mint) {
    mint = mintToken(ctx).finally(() => mintsInFlight.delete(ctx.userId));
    mintsInFlight.set(ctx.userId, mint);
  }
  return mint;
}

/** Encode defined params as Premier's `parameter.<name>` query string. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(`parameter.${key}`, String(value));
  }
  return qs.toString();
}

/** Unwrap Premier's `{ Data, Message, Code }` envelope into rows. */
function unwrapList(parsed: unknown): Record<string, unknown>[] {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError('Premier returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const envelope = parsed as Record<string, unknown>;
  if (Array.isArray(envelope.Data)) {
    return envelope.Data.map((row) =>
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {},
    );
  }
  const message = typeof envelope.Message === 'string' ? envelope.Message.trim() : '';
  if (message) {
    throw new ToolError(`Premier reported an error: ${message}`, { retryable: false });
  }
  return [];
}

/** Map a non-ok Premier response to a ToolError (always throws). */
function throwPremierError(status: number, body: string): never {
  if (status === 401 || status === 403) {
    throw new ToolError(
      'Premier refused the request even after re-authenticating — the API user may lack ' +
        'permission for this module, or the credentials were revoked.',
      { retryable: false },
    );
  }
  if (status === 400 || status === 404) {
    let reason = '';
    try {
      const parsed = JSON.parse(body) as { Message?: unknown; message?: unknown };
      const m = parsed.Message ?? parsed.message;
      if (typeof m === 'string') reason = m;
    } catch {
      reason = body.slice(0, 120);
    }
    throw new ToolError(`Premier rejected the request: ${reason || `HTTP ${status}`}.`, {
      retryable: false,
    });
  }
  throw new ToolError(`Premier returned ${status}: ${body.slice(0, 100)}`, {
    retryable: status === 429 || status >= 500,
  });
}

/** Parse a Premier JSON body, or throw a retryable "malformed data" ToolError. */
function parsePremierBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ToolError('Premier returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
}

/**
 * GET a Premier endpoint with the user's bearer attached, unwrap the envelope.
 * On a 401 the cached token is dropped and the request retried once with a
 * fresh mint (API-user sessions can be revoked server-side before expiry).
 */
export async function jonasGet(
  path: string,
  params: Record<string, string | number | undefined>,
  ctx: ToolContext,
  retried = false,
): Promise<Record<string, unknown>[]> {
  const token = await getToken(ctx);
  const query = buildQuery(params);
  const res = await ctx.fetch(`${BASE_URL}${path}${query ? `?${query}` : ''}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && !retried) {
    tokenCache.delete(ctx.userId);
    return jonasGet(path, params, ctx, true);
  }
  const body = await res.text();
  if (!res.ok) throwPremierError(res.status, body);
  return unwrapList(parsePremierBody(body));
}
