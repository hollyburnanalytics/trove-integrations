import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * Toggl time-tracking MCP server, hosted on Trove — the read-only equivalent of
 * the Toggl Track API: verify auth, list workspaces, and pull time entries.
 *
 * Auth is HTTP Basic with the user's personal API token as the username and the
 * literal `api_token` as the password (Toggl's documented scheme). The token is
 * a declared secret resolved per-invocation from Trove's vault; the only egress
 * is api.track.toggl.com (manifest allowlist).
 *
 * Rate limiting: Toggl documents a leaky bucket at roughly 1 request/second per
 * API token per IP and requires the *client* to back off once it returns 429.
 * Every tool here issues a single request, so the only way to trip the bucket is
 * a burst of calls (or another integration sharing the token — Toggl counts
 * those against the same budget). A 429 is therefore surfaced as a retryable
 * ToolError carrying `retryAfter`, never as a hard failure and never as "not
 * authenticated".
 */

const TOGGL = 'https://api.track.toggl.com/api/v9';

/** Toggl Basic-auth header: `base64("<token>:api_token")`. */
function authHeader(token: string): string {
  return `Basic ${btoa(`${token}:api_token`)}`;
}

/** Seconds → a compact `Hh Mm` label (running entries report negative duration). */
function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** `Retry-After` in seconds, when Toggl sends one (it may be absent on 429). */
function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Map a non-2xx Toggl response to a model-safe ToolError.
 *
 * 429 and 5xx are retryable (the model should wait and try again); 401/403 are
 * not — a bad or revoked token will not fix itself.
 */
function togglError(what: string, res: Response): ToolError {
  if (res.status === 429) {
    const after = retryAfterSeconds(res);
    return new ToolError(
      `Toggl rate limit reached (it allows about 1 request per second per token). Wait ${
        after ? `${after}s` : 'a second'
      } and try again.`,
      { retryable: true, data: { retryAfter: after } },
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new ToolError(
      `Toggl rejected the API token (HTTP ${res.status}). Check the TOGGL_API_TOKEN secret.`,
      { retryable: false },
    );
  }
  return new ToolError(`Failed to ${what} (HTTP ${res.status}).`, {
    retryable: res.status >= 500,
  });
}

/** GET a Toggl endpoint as JSON, with the shared error mapping applied. */
async function togglJson(
  path: string,
  what: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
  token: string,
): Promise<unknown> {
  return ctx.fetchJson(`${TOGGL}${path}`, {
    init: { headers: { accept: 'application/json', Authorization: authHeader(token) } },
    errorMap: (res) => togglError(what, res),
  });
}

interface TogglMe {
  id: number;
  email: string;
  fullname: string;
}
interface TogglWorkspace {
  id: number;
  name: string;
}
interface TogglEntry {
  id: number;
  description: string | null;
  duration: number;
  start: string;
  stop: string | null;
  workspace_id: number;
  project_id: number | null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'check_auth',
      title: 'Toggl: Check authentication',
      description: 'Verify Toggl API connectivity and return the authenticated user.',
      input: z.object({}),
      output: z.object({
        authenticated: z.boolean(),
        id: z.number().optional(),
        email: z.string().optional(),
        fullname: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(_args, ctx) {
        const token = await ctx.requireSecret('TOGGL_API_TOKEN');
        const res = await ctx.fetch(`${TOGGL}/me`, {
          headers: { Authorization: authHeader(token) },
        });
        // A rate limit or an outage says nothing about the token's validity —
        // only an actual rejection means "not authenticated".
        if (res.status === 429 || res.status >= 500) throw togglError('check authentication', res);
        if (!res.ok) {
          return {
            text: `Not authenticated — Toggl returned HTTP ${res.status}.`,
            structured: { authenticated: false },
          };
        }
        const me = (await res.json()) as TogglMe;
        return {
          text: `Authenticated as ${me.fullname} (${me.email}).`,
          structured: { authenticated: true, id: me.id, email: me.email, fullname: me.fullname },
        };
      },
    },
    {
      name: 'list_workspaces',
      title: 'Toggl: List workspaces',
      description: 'List all Toggl workspaces the authenticated user can access.',
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(_args, ctx) {
        const token = await ctx.requireSecret('TOGGL_API_TOKEN');
        const ws = (await togglJson('/workspaces', 'list workspaces', ctx, token)) as
          | TogglWorkspace[]
          | undefined;
        const workspaces = (ws ?? []).map((w) => ({ id: w.id, name: w.name }));
        return {
          text: workspaces.length
            ? `${workspaces.length} workspace(s): ${workspaces.map((w) => `${w.name} (${w.id})`).join(', ')}`
            : 'No workspaces found.',
          structured: { workspaces },
        };
      },
    },
    {
      name: 'get_time_entries',
      title: 'Toggl: Get time entries',
      description:
        "Get the authenticated user's recent time entries, optionally within a date range. Defaults to the most recent entries.",
      input: z.object({
        start_date: z
          .string()
          .optional()
          .describe('Start date, YYYY-MM-DD or RFC3339 (inclusive).'),
        end_date: z.string().optional().describe('End date, YYYY-MM-DD or RFC3339 (exclusive).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler({ start_date, end_date }, ctx) {
        const token = await ctx.requireSecret('TOGGL_API_TOKEN');
        const params = new URLSearchParams();
        if (start_date) params.set('start_date', start_date);
        if (end_date) params.set('end_date', end_date);
        const query = params.size > 0 ? `?${params}` : '';
        const entries = ((await togglJson(
          `/me/time_entries${query}`,
          'fetch time entries',
          ctx,
          token,
        )) ?? []) as TogglEntry[];
        const totalSeconds = entries.reduce((n, e) => n + (e.duration > 0 ? e.duration : 0), 0);
        const lines = entries
          .slice(0, 25)
          .map(
            (e) =>
              `• ${e.description?.trim() || '(no description)'} — ${
                e.duration > 0 ? fmtDuration(e.duration) : 'running'
              }`,
          );
        return {
          text: `${entries.length} time entr${entries.length === 1 ? 'y' : 'ies'} · ${fmtDuration(
            totalSeconds,
          )} tracked${lines.length ? `\n${lines.join('\n')}` : ''}`,
          structured: { count: entries.length, totalSeconds, entries },
        };
      },
    },
  ],
});
