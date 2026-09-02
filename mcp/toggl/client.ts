import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';

/**
 * Transport for the Toggl 2.0 API (`https://focus.toggl.com/api`, the "Toggl
 * Focus API" in its own OpenAPI document): the bearer header, the quota headers,
 * the error mapping, and the one GET helper every tool goes through. The wire
 * shapes the tools read are declared at the bottom.
 *
 * Toggl 2.0 is a different product from Toggl Track, with a different host, a
 * different credential and a different budget:
 *
 * - **Auth is a bearer API key** (`Authorization: Bearer toggl_sk_…`), generated
 *   once in the Toggl 2.0 profile settings, shown once, one active key per user,
 *   expiring on the date chosen at generation. Track's Basic `token:api_token`
 *   scheme does not exist here.
 * - **The budget is an hourly quota per user per organization**, tied to the
 *   plan — Free 30, Starter 240, Premium 600 requests an hour — and exhaustion
 *   is signalled with **HTTP 402**, not 429, because it is the plan's allocation
 *   that ran out. Every response carries `X-Toggl-Quota-Remaining` and
 *   `X-Toggl-Quota-Resets-In`, so the budget is read off every call rather than
 *   discovered by hitting it.
 * - **Errors are `{ error, error_description, trace_id }`**: `error` is a code
 *   (`invalid_session`), `error_description` the sentence worth showing.
 */

const BASE = 'https://focus.toggl.com/api';

/** Toggl 2.0 bearer header: the personal API key, verbatim. */
export function authHeader(key: string): string {
  return `Bearer ${key}`;
}

/** The hourly budget, as Toggl 2.0 reports it on every response. */
export interface Quota {
  /** Requests left in the current hour, for this user in this organization. */
  remaining?: number;
  /** Seconds until the hourly window resets, as Toggl reports it. */
  resetsIn?: number;
}

function numericHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Read the quota headers off a response; `undefined` when Toggl sent none. */
export function readQuota(response: Response): Quota | undefined {
  const quota: Quota = {
    remaining: numericHeader(response, 'x-toggl-quota-remaining'),
    resetsIn: numericHeader(response, 'x-toggl-quota-resets-in'),
  };
  return quota.remaining === undefined && quota.resetsIn === undefined ? undefined : quota;
}

/** `3599` → `59m`, `7260` → `2h 1m`, for saying when the budget comes back. */
export function untilReset(seconds?: number): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.max(1, Math.round((seconds % 3600) / 60));
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A prose warning when the hourly budget is nearly spent.
 *
 * A threshold rather than a running commentary: the number is always in the
 * structured result, but on a Free plan's 30 requests an hour a caller planning
 * several calls deserves to be told before the next one answers 402.
 */
export function quotaNote(quota?: Quota, threshold = 5): string[] {
  if (quota?.remaining === undefined || quota.remaining > threshold) return [];
  const back = untilReset(quota.resetsIn);
  const when = back ? `, resetting in ${back}` : '';
  return [
    `BUDGET: ${quota.remaining} Toggl 2.0 API request(s) left this hour${when}. ` +
      'The quota is per user per organization and shared by every integration using this key.',
  ];
}

/**
 * The sentence Toggl 2.0 put in an error body, when it put one.
 *
 * Errors arrive as `{ error, error_description, trace_id }` — the description
 * is the readable half ("the provided API key is invalid"); `error` is a code.
 */
export function upstreamMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; error_description?: unknown };
    const description = parsed.error_description;
    if (typeof description === 'string' && description) return description;
    return typeof parsed.error === 'string' && parsed.error ? parsed.error : undefined;
  } catch {
    return trimmed.slice(0, 160);
  }
}

/**
 * Map a non-2xx Toggl 2.0 response to a model-safe ToolError.
 *
 * 402 is the one that needs explaining: it is the **hourly quota**, retryable
 * once the window resets, and never a billing problem with the caller's card.
 * 401 is a bad, expired or revoked key and will not fix itself; 403 is a role
 * or plan boundary, likewise. 429 and 5xx are transient.
 */
export function togglError(what: string, response: Response, body: string): ToolError {
  const detail = upstreamMessage(body);
  const suffix = detail ? `: ${detail}` : '';
  const { status } = response;

  if (status === 402) {
    const quota = readQuota(response);
    const back = untilReset(quota?.resetsIn);
    return new ToolError(
      'Toggl 2.0 hourly API quota exhausted (Free 30 / Starter 240 / Premium 600 requests per hour, per user per organization). ' +
        `Wait ${back ?? 'for the window to reset'} and try again.`,
      { retryable: true, data: { quota } },
    );
  }
  if (status === 401) {
    return new ToolError(
      `Toggl 2.0 rejected the API key (HTTP 401${suffix}). Check the TOGGL_API_KEY secret: ` +
        'keys start with toggl_sk_, expire on the date chosen when generated, and generating a new key revokes the old one.',
      { retryable: false },
    );
  }
  if (status === 403) {
    return new ToolError(
      `Toggl 2.0 refused to ${what} (HTTP 403${suffix}). The key carries your own role, so this is a permission or plan boundary — or the organization/workspace ids do not belong to this account.`,
      { retryable: false },
    );
  }
  if (status === 404) {
    return new ToolError(`Toggl 2.0 could not ${what} (HTTP 404${suffix}).`, { retryable: false });
  }
  if (status === 429) {
    return new ToolError(`Toggl 2.0 rate limit hit while trying to ${what}; try again shortly.`, {
      retryable: true,
    });
  }
  return new ToolError(`Failed to ${what} (HTTP ${status}${suffix}).`, {
    retryable: status >= 500,
  });
}

/** What a Toggl 2.0 GET came back with: the parsed body and the budget. */
export interface TogglResult<T> {
  /** The parsed JSON body; `undefined` on 204. */
  body: T | undefined;
  quota?: Quota;
}

/**
 * Parse a response body that is either one JSON document or newline-delimited
 * JSON.
 *
 * The `/time-entries/stream` endpoints are documented as producing
 * `application/json` with an array schema, but "streaming the response" is the
 * kind of phrase that turns out to mean NDJSON once a real server is on the
 * other end. Accepting both costs nothing and keeps the one-request read.
 */
export function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').filter((line) => line.trim());
    return lines.map((line) => JSON.parse(line) as unknown);
  }
}

/**
 * GET a Toggl 2.0 endpoint, returning the parsed body and the quota headers.
 *
 * Goes through `ctx.fetch` rather than `ctx.fetchJson` because the budget is
 * only in the **headers**, and `fetchJson` hands back the body alone. The guards
 * `fetchJson` would have applied are reproduced: network failure and malformed
 * JSON are retryable, non-2xx goes through {@link togglError}, and a 204 (the
 * documented "not tracking" answer) is an `undefined` body rather than an error.
 */
export async function togglGet<T>(
  path: string,
  what: string,
  ctx: Pick<ToolContext, 'fetch'>,
  key: string,
): Promise<TogglResult<T>> {
  let response: Response;
  try {
    response = await ctx.fetch(`${BASE}${path}`, {
      headers: { accept: 'application/json', Authorization: authHeader(key) },
    });
  } catch {
    throw new ToolError(`Could not reach Toggl 2.0 to ${what}; try again shortly.`, {
      retryable: true,
    });
  }
  const quota = readQuota(response);
  const text = await response.text();
  if (!response.ok) throw togglError(what, response, text);
  if (response.status === 204) return { body: undefined, quota };
  try {
    return { body: parseBody(text) as T, quota };
  } catch {
    throw new ToolError(`Toggl 2.0 returned malformed data while trying to ${what}; try again.`, {
      retryable: true,
    });
  }
}

/** `/users/me/settings` — the fields this toolkit reads. */
export interface TogglUserSettings {
  current_workspace_id?: number | null;
  timezone?: string | null;
  /** 0 = Sunday, 1 = Monday. */
  start_week_on?: number | null;
  duration_format?: string | null;
}
export interface TogglTagLite {
  id: number;
  name: string;
}
export interface TogglClientLite {
  id: number;
  name: string;
}
/** `models.ProjectLite` — the project embedded on a time entry or task. */
export interface TogglProjectLite {
  id: number;
  name: string;
  client?: TogglClientLite | null;
  archived_at?: string | null;
}
export interface TogglTaskLite {
  id: number;
  name?: string | null;
}
/** `timeentry.TimeEntryWithTask` — an entry as the workspace list returns it. */
export interface TogglEntry {
  id: number;
  description?: string | null;
  /** Seconds. Absent or null while the entry is still running. */
  duration?: number | null;
  start: string;
  billable?: boolean | null;
  type?: 'activity' | 'break' | null;
  workspace_id?: number;
  project_id?: number | null;
  project?: TogglProjectLite | null;
  task_id?: number | null;
  task?: TogglTaskLite | null;
  /** The effective tags, already resolved by the API (override or the task's). */
  tags?: TogglTagLite[] | null;
  toggl_user_id?: number | null;
  /** The creator's IANA zone, snapshotted at creation. */
  timezone?: string | null;
}
/** `models.ProjectWithAggregations` — a project as the workspace list returns it. */
export interface TogglProject {
  id: number;
  name: string;
  client?: TogglClientLite | null;
  client_id?: number | null;
  billable?: boolean | null;
  archived_at?: string | null;
  completed_at?: string | null;
  color?: string | null;
  total_tracked_secs?: number | null;
}
