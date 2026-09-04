import { tool, z } from '@ontrove/extend/toolkit';
import { quotaNote } from '../client.ts';
import { fmtDuration } from '../entries.ts';
import { fetchProjects } from '../projects.ts';
import { resolveScope } from '../scope.ts';

/**
 * `list_projects` — the workspace's projects, with client names and totals.
 *
 * Pages of 100 (the live cap) followed as far as `total` says, bounded in
 * `projects.ts`; `truncated` says when a workspace was larger than the bound.
 */
export const listProjects = tool({
  name: 'list_projects',
  title: 'Toggl: List projects',
  description:
    "List the workspace's Toggl 2.0 projects with their client names and total tracked time — the way to turn a project or client name into the id get_time_entries filters on. Active projects by default. One request per 100 projects.",
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
    const pages = await fetchProjects(scope, ctx, key, { includeArchived: include_archived, name });
    const projects = pages.projects.map((p) => ({
      id: p.id,
      name: p.name,
      clientId: p.client?.id ?? p.client_id ?? undefined,
      clientName: p.client?.name,
      billable: p.billable === true,
      archived: Boolean(p.archived_at),
      completed: Boolean(p.completed_at),
      totalTrackedSeconds: p.total_tracked_secs ?? undefined,
    }));
    const budget = pages.quota ?? scopeQuota;
    const lines = projects.map((p) => {
      const client = p.clientName ? ` — ${p.clientName}` : '';
      const tracked = p.totalTrackedSeconds ? ` · ${fmtDuration(p.totalTrackedSeconds)}` : '';
      const archived = p.archived ? ' [archived]' : '';
      return `• ${p.name} (${p.id})${client}${tracked}${archived}`;
    });
    const text =
      projects.length > 0
        ? [
            `${projects.length} of ${pages.total} project(s) in workspace ${scope.workspaceId}:`,
            ...lines,
          ]
        : [`No projects found in workspace ${scope.workspaceId}.`];
    if (pages.truncated) text.push('(Stopped after 500 projects; narrow with name.)');
    return {
      text: [...text, ...quotaNote(budget)].join('\n'),
      structured: {
        workspaceId: scope.workspaceId,
        total: pages.total,
        truncated: pages.truncated,
        projects,
        quota: budget,
      },
    };
  },
});
