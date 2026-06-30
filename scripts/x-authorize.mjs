#!/usr/bin/env node

/**
 * One-time X (Twitter) OAuth 2.0 authorize helper — Authorization Code + PKCE.
 *
 * The `x` MCP server's `get_bookmarks` tool and the `x-bookmarks` connector both
 * read your bookmarks via OAuth 2.0 **user-context** (scope `bookmark.read`),
 * which needs a long-lived refresh token. This script walks the interactive
 * authorize flow once and prints that refresh token plus the commands to store
 * it. It holds NO secrets itself — the client id/secret and redirect URI come
 * from the environment or argv.
 *
 * Prerequisites (X developer portal → your app → User authentication settings):
 *  - App type "Web App / Native App" (PKCE), scopes incl. `bookmark.read`.
 *  - A registered Redirect URI. Use a localhost one (default below) so this
 *    script can capture the callback automatically.
 *
 * Usage:
 *   X_OAUTH_CLIENT_ID=... \
 *   [X_OAUTH_CLIENT_SECRET=...] \           # only for a confidential client
 *   [X_OAUTH_REDIRECT_URI=http://localhost:8723/callback] \
 *     node scripts/x-authorize.mjs
 *
 *   # equivalently, via flags:
 *   node scripts/x-authorize.mjs --client-id=... [--client-secret=...] \
 *     [--redirect-uri=http://localhost:8723/callback] [--manual]
 *
 * With a localhost redirect URI the script starts a tiny listener and captures
 * the `?code=` automatically. Pass `--manual` (or use a non-localhost redirect
 * URI) to instead paste the full redirect URL back in. Nothing is written to
 * disk; copy the printed `trove secret set` commands to store the credentials.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { argv, env, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const SCOPES = 'tweet.read users.read bookmark.read offline.access';
const DEFAULT_REDIRECT_URI = 'http://localhost:8723/callback';

/** Base64url (no padding) of a buffer. */
function base64Url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Read a `--flag=value` from argv, falling back to an env var. */
function readOption(flag, environmentName) {
  const prefix = `--${flag}=`;
  const match = argv.find((argument) => argument.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  return environmentName ? env[environmentName] : undefined;
}

/** Wait for the OAuth redirect on a localhost listener and return its query. */
function awaitRedirect(redirectUri) {
  const parsed = new URL(redirectUri);
  const port = parsed.port ? Number(parsed.port) : 80;
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url, `http://${parsed.host}`);
      if (requestUrl.pathname !== parsed.pathname) {
        response.writeHead(404).end('Not found');
        return;
      }
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      const error = requestUrl.searchParams.get('error');
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">' +
            '<h2>X authorization received.</h2><p>You can close this tab and return to the terminal.</p>',
        );
      server.close();
      if (error) reject(new Error(`Authorization denied: ${error}`));
      else resolve({ code, state });
    });
    server.on('error', reject);
    server.listen(port, () => {
      stdout.write(`Listening for the redirect on ${redirectUri} ...\n`);
    });
  });
}

/** Prompt the user to paste the full redirect URL, return its query. */
async function promptRedirect() {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const pasted = await readline.question(
      '\nAfter approving, paste the FULL redirect URL (or just the code) here:\n> ',
    );
    const trimmed = pasted.trim();
    if (trimmed.includes('?') || trimmed.includes('code=')) {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `http://localhost/?${trimmed}`);
      return { code: url.searchParams.get('code'), state: url.searchParams.get('state') };
    }
    return { code: trimmed, state: undefined };
  } finally {
    readline.close();
  }
}

/** Exchange the authorization code for tokens at the token endpoint. */
async function exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }
  const response = await fetch(TOKEN_URL, { method: 'POST', headers, body: form.toString() });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const clientId = readOption('client-id', 'X_OAUTH_CLIENT_ID');
  const clientSecret = readOption('client-secret', 'X_OAUTH_CLIENT_SECRET');
  const redirectUri = readOption('redirect-uri', 'X_OAUTH_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI;
  const manual = argv.includes('--manual');

  if (!clientId) {
    throw new Error(
      'Set X_OAUTH_CLIENT_ID (env or --client-id=...). See the header of this file for usage.',
    );
  }

  const codeVerifier = base64Url(randomBytes(48));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const state = base64Url(randomBytes(16));

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  stdout.write('\n1) Open this URL in a browser and approve access:\n\n');
  stdout.write(`${authorizeUrl.toString()}\n`);

  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(redirectUri).hostname);
  const useListener = isLocalhost && !manual;
  const redirect = await (useListener ? awaitRedirect(redirectUri) : promptRedirect());

  if (!redirect.code) throw new Error('No authorization code was returned.');
  if (redirect.state && redirect.state !== state) {
    throw new Error('State mismatch — possible CSRF; aborting.');
  }

  const tokens = await exchangeCode({
    code: redirect.code,
    clientId,
    clientSecret,
    redirectUri,
    codeVerifier,
  });
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token returned — ensure the `offline.access` scope is granted.');
  }

  stdout.write('\n✓ Authorized. Refresh token (store it securely, do not commit):\n\n');
  stdout.write(`${tokens.refresh_token}\n`);
  stdout.write('\n2) Store the credentials for the `x` MCP server:\n\n');
  stdout.write(`   trove secret set x X_OAUTH_CLIENT_ID '${clientId}'\n`);
  if (clientSecret) stdout.write('   trove secret set x X_OAUTH_CLIENT_SECRET --from-stdin\n');
  stdout.write('   trove secret set x X_OAUTH_REFRESH_TOKEN --from-stdin\n');
  stdout.write(
    '\n   (The x-bookmarks connector reads the same X_OAUTH_CLIENT_ID / ' +
      'X_OAUTH_CLIENT_SECRET / X_OAUTH_REFRESH_TOKEN via ctx.credentials.)\n' +
      '\n   Pass the token over stdin rather than argv so it stays out of your shell history,\n' +
      '   e.g.:  printf %s "<refresh-token>" | trove secret set x X_OAUTH_REFRESH_TOKEN --from-stdin\n',
  );
}

await main();
