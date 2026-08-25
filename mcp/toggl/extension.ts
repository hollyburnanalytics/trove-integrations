import { defineToolkit, tool, z } from '@ontrove/extend/toolkit';
import {
  authHeader,
  dateRangeFor,
  fmtDuration,
  type HydratedEntry,
  hydrate,
  maskEmail,
  PERIODS,
  type TogglEntry,
  type TogglMe,
  type TogglWorkspace,
  togglError,
  togglJson,
} from './client.ts';

/**
 * Toggl time-tracking MCP server, hosted on Trove — a read-only window onto the
 * caller's own Toggl Track account: who the token belongs to, which workspaces
 * it reaches, and time entries resolved to workspace/project/client/tag *names*.
 *
 * Auth is Toggl's documented Basic scheme, resolved per-invocation via
 * `ctx.requireSecret`; the only egress is api.track.toggl.com. Transport,
 * hydration and the date-range maths live in `client.ts`.
 *
 * Named periods are timezone-aware on purpose. This server runs in UTC, so a
 * naive "today" rolls over mid-afternoon for a Pacific user; `time_zone` decides
 * which calendar day is meant.
 */

/** Roll up a hydrated batch by client (falling back to project, then workspace). */
function summarise(entries: HydratedEntry[]): { label: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (e.duration <= 0) continue;
    const label = e.clientName ?? e.projectName ?? e.workspaceName ?? 'Unassigned';
    totals.set(label, (totals.get(label) ?? 0) + e.duration);
  }
  return [...totals]
    .map(([label, seconds]) => ({ label, seconds }))
    .toSorted((a, b) => b.seconds - a.seconds);
}

export default defineToolkit({
  id: 'toggl',
  name: 'Toggl Time Tracking',
  description:
    "Query Toggl Track time entries, resolved to project/client/tag names, with named periods (today, week, lastMonth…) and a per-client duration roll-up. Requires a TOGGL_API_TOKEN secret (Toggl profile → API token). Read-only; honours Toggl's 1 request/second limit and backs off on HTTP 429.",
  icon: '⏱️',
  version: '2.0.0',
  secrets: ['TOGGL_API_TOKEN'],
  egress: ['api.track.toggl.com'],
  scopes: [],
  visibility: 'shared',
  tools: [
    tool({
      name: 'check_auth',
      title: 'Toggl: Check authentication',
      description:
        'Verify Toggl API connectivity and return the authenticated user plus the workspaces the token can reach. The email is masked.',
      input: z.object({}),
      output: z.object({
        authenticated: z.boolean(),
        id: z.number().optional(),
        email: z.string().optional(),
        fullname: z.string().optional(),
        workspaces: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(_args, ctx) {
        const token = await ctx.requireSecret('TOGGL_API_TOKEN');
        const response = await ctx.fetch('https://api.track.toggl.com/api/v9/me', {
          headers: { Authorization: authHeader(token) },
        });
        // A rate limit or an outage says nothing about the token's validity —
        // only an actual rejection means "not authenticated".
        if (response.status === 429 || response.status >= 500) {
          throw togglError('check authentication', response);
        }
        if (!response.ok) {
          return {
            text: `Not authenticated — Toggl returned HTTP ${response.status}.`,
            structured: { authenticated: false },
          };
        }
        const me = (await response.json()) as TogglMe;
        const list = (await togglJson('/workspaces', 'list workspaces', ctx, token)) as
          | TogglWorkspace[]
          | undefined;
        const workspaces = (list ?? []).map((w) => ({ id: w.id, name: w.name }));
        const named = workspaces.map((w) => `${w.name} (${w.id})`).join(', ');
        return {
          text:
            `Authenticated as ${me.fullname} (${maskEmail(me.email)}) — ` +
            `${workspaces.length} workspace(s): ${named}`,
          structured: {
            authenticated: true,
            id: me.id,
            email: maskEmail(me.email),
            fullname: me.fullname,
            workspaces,
          },
        };
      },
    }),
    tool({
      name: 'list_workspaces',
      title: 'Toggl: List workspaces',
      description: 'List all Toggl workspaces the authenticated user can access.',
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(_args, ctx) {
        const token = await ctx.requireSecret('TOGGL_API_TOKEN');
        const list = (await togglJson('/workspaces', 'list workspaces', ctx, token)) as
          | TogglWorkspace[]
          | undefined;
        const workspaces = (list ?? []).map((w) => ({ id: w.id, name: w.name }));
        const named = workspaces.map((w) => `${w.name} (${w.id})`).join(', ');
        return {
          text:
            workspaces.length > 0
              ? `${workspaces.length} workspace(s): ${named}`
              : 'No workspaces found.',
          structured: { workspaces },
        };
      },
    }),
    tool({
      name: 'get_time_entries',
      title: 'Toggl: Get time entries',
      description:
        "Get the authenticated user's time entries for a period or explicit date range, resolved to workspace, project, client and tag names, with a per-client duration roll-up. Good for invoicing and weekly reviews: ask for a range, get named entries plus totals.",
      input: z.object({
        period: z
          .enum(PERIODS)
          .optional()
          .describe(
            'Named range, evaluated in time_zone. Takes precedence over start_date/end_date. Defaults to today when no range is given at all.',
          ),
        start_date: z
          .string()
          .optional()
          .describe('Range start, YYYY-MM-DD (inclusive). Ignored when period is set.'),
        end_date: z
          .string()
          .optional()
          .describe('Range end, YYYY-MM-DD (exclusive). Ignored when period is set.'),
        time_zone: z
          .string()
          .default('UTC')
          .describe(
            'IANA time zone deciding which calendar day a named period means, e.g. America/Vancouver. Defaults to UTC.',
          ),
        workspace_id: z.number().int().optional().describe('Only entries in this workspace.'),
        project_id: z.number().int().optional().describe('Only entries on this project.'),
        billable_only: z.boolean().default(false).describe('Only entries marked billable.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(
        { period, start_date, end_date, time_zone, workspace_id, project_id, billable_only },
        ctx,
      ) {
        // Resolve the window before redeeming the secret — a bad time zone
        // should fail without a vault round-trip.
        const range =
          period || (!start_date && !end_date)
            ? dateRangeFor(period ?? 'today', time_zone, new Date())
            : { start: start_date ?? '', end: end_date ?? '' };

        const token = await ctx.requireSecret('TOGGL_API_TOKEN');
        const params = new URLSearchParams();
        if (range.start) params.set('start_date', range.start);
        if (range.end) params.set('end_date', range.end);
        const query = params.size > 0 ? `?${params}` : '';

        const raw = ((await togglJson(
          `/me/time_entries${query}`,
          'fetch time entries',
          ctx,
          token,
        )) ?? []) as TogglEntry[];

        const filtered = raw.filter(
          (e) =>
            (workspace_id === undefined || e.workspace_id === workspace_id) &&
            (project_id === undefined || e.project_id === project_id) &&
            (!billable_only || e.billable === true),
        );

        const entries = await hydrate(filtered, ctx, token);
        const totalSeconds = entries.reduce((n, e) => n + Math.max(e.duration, 0), 0);
        const byClient = summarise(entries);

        const lines = entries
          .slice(0, 30)
          .map(
            (e) =>
              `• ${e.start.slice(0, 10)} ${
                e.running ? 'running' : fmtDuration(e.duration).padStart(7)
              } — ${e.description}${e.projectName ? ` [${e.projectName}]` : ''}${
                e.clientName ? ` (${e.clientName})` : ''
              }${e.billable ? ' 💲' : ''}`,
          );
        const rollup = byClient.map((c) => `  ${c.label}: ${fmtDuration(c.seconds)}`);

        const plural = entries.length === 1 ? 'y' : 'ies';
        const heading =
          `${entries.length} entr${plural} from ${range.start} to ${range.end} ` +
          `(end exclusive) · ${fmtDuration(totalSeconds)} tracked`;
        return {
          text:
            entries.length > 0
              ? `${heading}\n${lines.join('\n')}\n\nBy client:\n${rollup.join('\n')}`
              : `No time entries between ${range.start} and ${range.end}.`,
          structured: {
            count: entries.length,
            totalSeconds,
            range,
            timeZone: time_zone,
            byClient,
            entries,
          },
        };
      },
    }),
  ],
});
