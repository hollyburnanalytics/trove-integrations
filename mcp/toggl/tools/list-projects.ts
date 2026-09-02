import { tool, z } from '@ontrove/extend/toolkit';
import { quotaNote, type TogglProject, togglGet } from '../client.ts';
import { fmtDuration } from '../entries.ts';
import { resolveScope, scopePath } from '../scope.ts';

/** The most a single page may ask for, per the reports API's documented ceiling. */
const PAGE = 200;

/**
 * `list_projects` — the workspace's projects, with client names and totals.
 *
 * One page of up to 200 (`models.PageWithTotal`), which is plenty for a
 * personal workspace; `total` says when it was not, so a larger workspace is
 * told rather than silently trimmed.
 */
export const listProjects = tool({
  name: 'list_projects',
  title: 'Toggl: List projects',
  description:
    "List the workspace's Toggl 2.0 projects with their client names and total tracked time — the way to turn a project or client name into the id get_time_entries filters on. Active projects by default. One request.",
  input: z.object({
    workspace_id: z
      .number()
      .int()
      .optional()
      .describe('Workspace to list. Defaults to the configured or current workspace.'),
    name: z
      .string()
      .optional()
      .describe('Only projects whose project or client name matches this text.'),
    include_archived: z.boolean().default(false).describe('Also list archived projects.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler({ workspace_id, name, include_archived }, ctx) {
    const key = await ctx.requireSecret('TOGGL_API_KEY');
    const { scope, quota: scopeQuota } = await resolveScope(ctx, key, workspace_id);
    const params = new URLSearchParams({ per_page: String(PAGE), page: '1' });
    // The API reads an EMPTY `archived` as "all projects" and an omitted one as
    // "active only", so the flag is sent empty rather than as `true`, which
    // would return archived projects ONLY.
    if (include_archived) params.set('archived', '');
    if (name) params.set('name', name);
    const { body, quota } = await togglGet<{ data?: TogglProject[]; total?: number }>(
      `${scopePath(scope)}/projects?${params}`,
      'list projects',
      ctx,
      key,
    );
    const projects = (body?.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      clientId: p.client?.id ?? p.client_id ?? undefined,
      clientName: p.client?.name,
      billable: p.billable === true,
      archived: Boolean(p.archived_at),
      completed: Boolean(p.completed_at),
      totalTrackedSeconds: p.total_tracked_secs ?? undefined,
    }));
    const total = body?.total ?? projects.length;
    const budget = quota ?? scopeQuota;
    const lines = projects.map((p) => {
      const client = p.clientName ? ` — ${p.clientName}` : '';
      const tracked = p.totalTrackedSeconds ? ` · ${fmtDuration(p.totalTrackedSeconds)}` : '';
      const archived = p.archived ? ' [archived]' : '';
      return `• ${p.name} (${p.id})${client}${tracked}${archived}`;
    });
    const text =
      projects.length > 0
        ? [`${projects.length} of ${total} project(s) in workspace ${scope.workspaceId}:`, ...lines]
        : [`No projects found in workspace ${scope.workspaceId}.`];
    return {
      text: [...text, ...quotaNote(budget)].join('\n'),
      structured: { workspaceId: scope.workspaceId, total, projects, quota: budget },
    };
  },
});
