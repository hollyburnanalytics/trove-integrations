import { ToolError } from '@ontrove/extend/toolkit';
import type { FetchResult } from '../lib/egress.ts';
import { GRAPH_VERSION } from './client.ts';

/**
 * Meta's error envelope, and the four different remedies hiding inside it.
 *
 * Graph almost never uses an HTTP status to say what went wrong: an expired
 * token, a missing Business Manager role, a rate limit, a query that asked for
 * too much data and a typo in a field name all arrive as `400` with an
 * `{"error":{"code":…}}` body. Flattened into one message they send every
 * caller to check their credentials — including the one whose credentials are
 * fine and who simply needs to wait ninety seconds. Everything here exists to
 * keep those apart, and each branch is asserted in the tests.
 */

/** Meta's error envelope, as far as anything here reads it. */
interface GraphError {
  message?: unknown;
  code?: unknown;
  error_subcode?: unknown;
  error_user_msg?: unknown;
  error_user_title?: unknown;
}

/**
 * Rate-limit codes, which Meta spreads over three unrelated-looking families:
 * the classic app/user/page limits (4, 17, 32), the ads-specific custom limit
 * (613), and the business-use-case block (80000–80014, one per product).
 * Everything here is "come back later", never "fix your request".
 */
function isRateLimitCode(code: number, subcode: number): boolean {
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 341) return true;
  if (code >= 80_000 && code <= 80_014) return true;
  // The ads-specific "too many calls" subcode, seen under code 100.
  return code === 100 && subcode === 2_446_079;
}

/** Pull Meta's error envelope out of a response body, if it has one. */
function parseGraphError(body: string): GraphError | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: GraphError };
    return typeof parsed.error === 'object' && parsed.error !== null ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** The most useful sentence Meta gave us, preferring the user-facing one. */
function errorText(error: GraphError): string {
  const userMessage = typeof error.error_user_msg === 'string' ? error.error_user_msg : '';
  if (userMessage) return userMessage;
  return typeof error.message === 'string' ? error.message : '';
}

/** Codes that mean the credential itself is no longer usable. */
const TOKEN_CODES = new Set([190, 102, 463]);
/** Codes that mean the credential is fine but is not allowed to do this. */
const PERMISSION_CODES = new Set([200, 10, 3]);
/** Codes that mean the object named in the request is not there. */
const MISSING_OBJECT_CODES = new Set([803, 2500]);

/**
 * Map one Graph error code to a typed tool error.
 *
 * Grouped by REMEDY rather than by code, because that is the only distinction
 * the reader can act on: re-authorize, ask an admin for a role, ask for less
 * data, or fix the request.
 */
function errorForCode(code: number, subcode: number, reason: string): ToolError {
  const detail = reason ? `: ${reason}` : '.';
  if (TOKEN_CODES.has(code)) {
    return new ToolError(
      `Meta rejected the access token (code ${code}${detail}) ` +
        'META_ACCESS_TOKEN is expired or invalid — mint a new long-lived or system-user ' +
        'token with the ads_read permission and set it again.',
      { retryable: false },
    );
  }
  if (PERMISSION_CODES.has(code)) {
    return new ToolError(
      `Meta refused for permissions (code ${code}${detail}) ` +
        'The token needs the ads_read permission AND its owner needs a role on this ad ' +
        'account in Business Manager.',
      { retryable: false },
    );
  }
  if (MISSING_OBJECT_CODES.has(code)) {
    return new ToolError(
      `Meta could not resolve that object${detail} Check the ad account, campaign, ad set ` +
        'or ad id.',
      { retryable: false },
    );
  }
  if (code === 100 && subcode === 1_487_534) {
    return new ToolError(
      'Meta refused the query as too large for one call. Narrow the date range, drop a ' +
        'breakdown, or use a coarser time_increment.',
      { retryable: false },
    );
  }
  if (code === 3018) {
    return new ToolError(`Meta only serves insights for the last 37 months${detail}`, {
      retryable: false,
    });
  }
  if (code === 2635) {
    return new ToolError(
      `Graph API ${GRAPH_VERSION} is no longer served (code 2635). This toolkit pins its ` +
        'version, so it needs updating — not retrying.',
      { retryable: false },
    );
  }
  return new ToolError(
    `Meta rejected the request (code ${code}${subcode ? `/${subcode}` : ''})${detail}`,
    { retryable: false },
  );
}

/**
 * Turn a non-2xx Graph response into a typed {@link ToolError}.
 *
 * Exported for the tests, which assert the classification directly: the whole
 * value of this function is that four unrelated remedies stop looking alike.
 */
export function metaError(result: FetchResult): ToolError {
  const error = parseGraphError(result.body);
  if (!error) {
    return new ToolError(
      `Meta returned HTTP ${result.status} with no error details. Try again shortly.`,
      { retryable: result.status >= 500 },
    );
  }
  const code = typeof error.code === 'number' ? error.code : 0;
  const subcode = typeof error.error_subcode === 'number' ? error.error_subcode : 0;
  const reason = errorText(error);
  if (isRateLimitCode(code, subcode)) {
    return new ToolError(
      `Meta is rate-limiting this ad account (code ${code}). Ad insights budget is ` +
        'per-account and refills over minutes — wait and retry, or ask for a shorter ' +
        'range or fewer breakdowns.',
      { retryable: true },
    );
  }
  // Codes 1 and 2 are Meta's own "unknown/temporary" pair: nothing about the
  // request is wrong, so they must not be reported as the caller's mistake.
  if (code === 1 || code === 2) {
    return new ToolError(`Meta had a transient error${reason ? `: ${reason}` : '.'}`, {
      retryable: true,
    });
  }
  return errorForCode(code, subcode, reason);
}
