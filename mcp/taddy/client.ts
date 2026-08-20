import { type ToolContext, ToolError, z } from '@ontrove/extend/toolkit';
import { createEgressClient } from '../lib/egress.ts';

/**
 * Shared Taddy plumbing: the egress client, the authenticated GraphQL POST, and
 * the error-code mapping every tool depends on being right.
 *
 * One endpoint, one method. Taddy is GraphQL, so every read — search, lookup,
 * charts, transcripts — is a POST of a query document to `https://api.taddy.org`
 * with `X-USER-ID` and `X-API-KEY` headers. Both are per-tenant secrets, so both
 * come from the vault via `ctx.requireSecret`; set them with
 * `trove secret set taddy TADDY_USER_ID …` (and `…TADDY_API_KEY…`).
 *
 * **Errors do not arrive as HTTP statuses.** A rejected Taddy query answers
 * `200 OK` with `{"errors":[{"code":…,"message":…}],"data":{…:null}}`. Anything
 * that reads only `res.status` therefore sees success and hands back `null` data
 * as if the podcast simply did not exist — so the whole of {@link toolErrorFor}
 * exists to turn those codes back into typed, correctly-retryable failures.
 *
 * **Quota is the scarce resource.** The free tier is 500 requests per MONTH, not
 * per minute, and every tool call spends one. That shapes two decisions here:
 * responses are cached in-isolate (a repeated query costs nothing), and each
 * tool fetches a whole object graph in one query rather than making the caller
 * paginate — GraphQL is what makes that free.
 */

const ENDPOINT = 'https://api.taddy.org';

/**
 * Taddy publishes no per-second rate limit — the plan quota is monthly — so this
 * is politeness, not a documented ceiling.
 *
 * The cache is the part that matters. It is keyed on the full request body (see
 * `cacheKey` in `lib/egress.ts`), so it distinguishes one GraphQL query from
 * another at the same URL, and a re-asked question costs zero quota instead of
 * one of 500.
 */
const taddy = createEgressClient({
  service: 'Taddy',
  throttleMs: 200,
  // `bodyStatuses: [400]` is load-bearing, and a live call is what proved it.
  // Taddy rejects a query it cannot serve with HTTP 400 AND a normal GraphQL
  // error envelope naming the exact problem — "Inside of responseDetails please
  // add the property id to the query". Without this the egress client hands back
  // a body-less 400, that sentence is gone, and every such rejection collapses
  // into "Taddy rejected the request as malformed": true, useless, and hiding
  // the one thing that would fix it.
  bodyStatuses: [400],
  cache: {
    ttlMs: 10 * 60_000,
    maxEntries: 64,
    maxEntryBytes: 2 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
  },
});

/**
 * On-demand transcription can take minutes, not seconds.
 *
 * Taddy transcribes roughly one hour of audio every ten seconds, so a long
 * back-catalogue episode legitimately holds the connection open far past the
 * 20s default budget. That default is right for every other query here and
 * wrong for exactly this one.
 */
export const TRANSCRIPT_TIMEOUT_MS = 110_000;

/** Taddy's GraphQL error envelope: a `code` category plus a human message. */
const errorWire = z.object({
  code: z.string().nullish(),
  message: z.string().nullish(),
});

const envelopeWire = z.object({
  data: z.unknown().nullish(),
  errors: z.array(errorWire).nullish(),
});

/**
 * A plan/entitlement refusal wearing the generic server-error code.
 *
 * Deliberately narrow: it must match Taddy's plan wording without swallowing a
 * genuine outage that happens to mention a word like "user".
 */
const PLAN_RESTRICTION = /\b(pro or business|upgrade your plan|paid plan)\b/i;

/**
 * Map a Taddy error code to a typed {@link ToolError}.
 *
 * The codes are documented and stable, and each wants a different response from
 * the caller: a blown monthly quota is not retryable *this month* and no amount
 * of backoff fixes it, whereas `TADDY_SERVER_ERROR` clears on its own. Flattening
 * both into one message would tell a user with a broken API key to wait, and a
 * user hitting a transient fault to go buy a bigger plan.
 */
function toolErrorFor(code: string | undefined, message: string): ToolError {
  switch (code) {
    case 'API_KEY_INVALID': {
      return new ToolError(
        'Taddy rejected the credentials. Check TADDY_USER_ID and TADDY_API_KEY — the user id is ' +
          'the short number from the Taddy dashboard, not the API key, and both are needed. ' +
          'Set them with `trove secret set taddy TADDY_USER_ID …`.',
        { retryable: false },
      );
    }
    case 'API_RATE_LIMIT_EXCEEDED': {
      return new ToolError(
        `Taddy's monthly API quota for this account is used up (${message}). It resets on the ` +
          'account billing date; the free tier is 500 requests/month. Retrying will not help.',
        { retryable: false },
      );
    }
    case 'BAD_USER_INPUT': {
      return new ToolError(`Taddy rejected an argument: ${message}`, { retryable: false });
    }
    case 'INVALID_QUERY_OR_SYNTAX':
    case 'QUERY_TOO_COMPLEX': {
      // The caller cannot fix this one — the query document is ours, not theirs.
      return new ToolError(`Taddy rejected the query (${code}): ${message}`, { retryable: false });
    }
    case 'REQUIRES_USER_AUTHENTICATION':
    case 'ACCESS_NOT_ALLOWED': {
      return new ToolError(
        `Taddy refused this request on the current plan: ${message}. Taddy-generated transcripts ` +
          'and some endpoints need a paid (Pro or Business) account.',
        { retryable: false },
      );
    }
    case 'TADDY_SERVER_ERROR': {
      // `TADDY_SERVER_ERROR` is documented as "something is wrong on our end",
      // but Taddy also uses it as a CATCH-ALL — a live call on a Free account
      // returns it verbatim for "You need to be a Pro or Business Taddy API user
      // to access the transcript for this episode." Trusting the code alone
      // would tell that caller to "try again shortly" about a plan restriction
      // that no amount of retrying resolves, and would have the SDK retry it.
      // The message is the only signal that separates the two, so it is read.
      if (PLAN_RESTRICTION.test(message)) {
        return new ToolError(
          `Taddy refused this request on the current plan: ${message} ` +
            'Taddy-generated transcripts (including ones already produced for the top ~5000 shows) ' +
            'need a Pro or Business account; transcripts the podcast publishes itself remain free.',
          { retryable: false },
        );
      }
      return new ToolError(`Taddy is having trouble right now (${message}). Try again shortly.`, {
        retryable: true,
      });
    }
    default: {
      return new ToolError(`Taddy returned an error: ${message}`, { retryable: false });
    }
  }
}

/**
 * Does this body carry a GraphQL error envelope?
 *
 * Used to keep failures OUT of the response cache. It matters more here than
 * almost anywhere, because Taddy reports every error — bad key, blown quota,
 * server fault — as `200 OK` with an `errors` array, which the cache would
 * otherwise treat as a perfectly good response and pin for ten minutes. The
 * consequences are the two worst kinds: a `TADDY_SERVER_ERROR` this client
 * classifies as retryable would be replayed from cache long after the upstream
 * recovered, making its own advice impossible to act on; and a user who fixes
 * an invalid `TADDY_API_KEY` would keep being told it is invalid.
 *
 * The substring pre-check keeps this cheap: a transcript body runs to megabytes
 * and must not be parsed twice just to learn it is fine.
 */
function carriesGraphQLErrors(body: string): boolean {
  if (!body.includes('"errors"')) return false;
  try {
    const parsed = envelopeWire.safeParse(JSON.parse(body));
    return parsed.success && (parsed.data.errors ?? []).length > 0;
  } catch {
    // Unparseable is not "has errors" — that path is handled below, and
    // declining to cache it is already the default for a body we cannot read.
    return false;
  }
}

/** Read the auth headers for this invocation from the vault. */
async function authHeaders(ctx: ToolContext): Promise<Record<string, string>> {
  const userId = await ctx.requireSecret('TADDY_USER_ID');
  const apiKey = await ctx.requireSecret('TADDY_API_KEY');
  return {
    'X-USER-ID': userId.trim(),
    'X-API-KEY': apiKey.trim(),
    accept: 'application/json',
  };
}

export interface GraphQLOptions {
  /**
   * Cache this response in the isolate. Default true.
   *
   * Set FALSE for anything whose answer is specific to the calling account.
   * The cache is module-scope and therefore shared by every user an isolate
   * serves; podcast catalogue data is public and identical for all of them, but
   * a quota balance is not — caching that would show one tenant another
   * tenant's remaining requests.
   */
  cacheable?: boolean;
  /** Override the whole-call budget (see {@link TRANSCRIPT_TIMEOUT_MS}). */
  overallTimeoutMs?: number;
}

/**
 * Execute one GraphQL query against Taddy and return its validated `data`.
 *
 * @param ctx - The tool invocation context.
 * @param query - The GraphQL document.
 * @param variables - Query variables (always used; nothing is interpolated into
 *   the document, so no caller value can alter its structure).
 * @param schema - A LENIENT Zod schema for the `data` payload.
 * @param options - Caching and timeout overrides.
 */
export async function graphql<S extends z.ZodTypeAny>(
  ctx: ToolContext,
  query: string,
  variables: Record<string, unknown>,
  schema: S,
  options: GraphQLOptions = {},
): Promise<z.infer<S>> {
  const body = JSON.stringify({ query, variables });
  const { status, body: text } = await taddy.fetch(ctx, ENDPOINT, {
    method: 'POST',
    body,
    headers: await authHeaders(ctx),
    cacheable: options.cacheable ?? true,
    // Per-USER, never server-wide. Most of what Taddy returns is public
    // catalogue data that would be identical for every tenant — but not all of
    // it: Taddy-generated transcripts are gated on the caller's plan, and a
    // quota balance is the caller's alone. A shared entry would serve a paid
    // account's transcript to a free one. Salting with the user id keeps the
    // saving that actually matters (the same caller re-asking) and drops only
    // the cross-tenant sharing that was never ours to give away.
    cacheKeySalt: ctx.userId,
    // Taddy answers failures with 200, so the cache cannot decide on status alone.
    retainIf: (result) => !carriesGraphQLErrors(result.body),
    overallTimeoutMs: options.overallTimeoutMs,
    timeoutMs: options.overallTimeoutMs,
  });

  // A 400 is NOT handled here: Taddy pairs it with the same `errors` envelope as
  // any other rejection, so it falls through to the parsing below and is mapped
  // by code like every other error — which is how its message survives.
  if (status === 404) {
    throw new ToolError('Taddy’s API endpoint could not be reached.', { retryable: true });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError('Taddy returned malformed data; try again shortly.', { retryable: true });
  }

  const envelope = envelopeWire.safeParse(parsed);
  if (!envelope.success) {
    throw new ToolError('Taddy returned an unexpected response shape; try again shortly.', {
      retryable: true,
    });
  }

  const errors = envelope.data.errors ?? [];
  const first = errors[0];
  if (first) {
    throw toolErrorFor(first.code ?? undefined, first.message ?? 'no message given');
  }

  const data = schema.safeParse(envelope.data.data ?? {});
  if (!data.success) {
    throw new ToolError('Taddy returned data in an unexpected shape; try again shortly.', {
      retryable: true,
    });
  }
  return data.data as z.infer<S>;
}
