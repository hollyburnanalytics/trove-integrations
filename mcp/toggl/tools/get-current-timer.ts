import { tool, z } from '@ontrove/extend/toolkit';
import { type Quota, quotaNote, type TogglEntry, type TogglProject, togglGet } from '../client.ts';
import {
  EntrySchema,
  fmtDuration,
  hydrate,
  isTracked,
  QuotaSchema,
  whereLabel,
} from '../entries.ts';
import { resolveScope, scopePath } from '../scope.ts';

/**
 * `get_current_timer` — what is being tracked right now.
 *
 * `/tracking/current` answers 204 when nothing is running, and otherwise a bare
 * `models.TimeEntry` carrying only `project_id`; one more request turns that
 * into a name, spent only when there is a project to name.
 */
export const getCurrentTimer = tool({
  name: 'get_current_timer',
  title: 'Toggl: Current timer',
  description:
    'What is being tracked right now: the running Toggl 2.0 time entry with its elapsed time, project and client, or a clear "nothing running". One request (two when the entry has a project, to name it).',
  input: z.object({
    workspace_id: z
      .number()
      .int()
      .optional()
      .describe('Workspace to look in. Defaults to the configured or current workspace.'),
  }),
  output: z.object({
    running: z.boolean(),
    entry: EntrySchema.optional(),
    quota: QuotaSchema,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler({ workspace_id }, ctx) {
    const key = await ctx.requireSecret('TOGGL_API_KEY');
    const { scope } = await resolveScope(ctx, key, workspace_id);
    const { body, quota } = await togglGet<TogglEntry>(
      `${scopePath(scope)}/tracking/current`,
      'read the current timer',
      ctx,
      key,
    );
    if (!body || !isTracked(body)) {
      return {
        text: `No timer running in workspace ${scope.workspaceId}.`,
        structured: { running: false, quota },
      };
    }
    const entry = hydrate(body, ctx.now());
    let budget: Quota | undefined = quota;
    if (entry.projectId !== undefined && !entry.projectName) {
      const project = await togglGet<TogglProject>(
        `${scopePath(scope)}/projects/${entry.projectId}`,
        'read the running project',
        ctx,
        key,
      );
      if (project.body) {
        entry.projectName = project.body.name;
        entry.clientId = project.body.client?.id;
        entry.clientName = project.body.client?.name;
      }
      budget = project.quota ?? quota;
    }
    const marks = (entry.billable ? ' 💲' : '') + (entry.type === 'break' ? ' (break)' : '');
    return {
      text: [
        `Running for ${fmtDuration(entry.duration)} since ${entry.start}: ${entry.description}${whereLabel(entry)}${marks}`,
        ...quotaNote(budget),
      ].join('\n'),
      structured: { running: true, entry, quota: budget },
    };
  },
});
