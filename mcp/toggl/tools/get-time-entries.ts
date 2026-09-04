import { tool, z } from '@ontrove/extend/toolkit';
import { quotaNote, type TogglEntry, togglGet } from '../client.ts';
import { PERIODS, resolveWindow } from '../dates.ts';
import { entryLine, fmtDuration, hydrate, isTracked, matching, summarise } from '../entries.ts';
import { clientLookup, fetchProjects } from '../projects.ts';
import { resolveScope, scopePath } from '../scope.ts';

/** How many entries the text mirror lists before deferring to the structured result. */
const LISTED = 30;

/**
 * `get_time_entries` — a period's entries, named, with a per-client roll-up.
 *
 * `/time-entries/stream` returns the whole window as one JSON array, so there
 * is no paging to get wrong against an hourly budget, and it embeds `project`,
 * `task` and the effective `tags`. Three things the live API does that the
 * document does not say, each handled here:
 *
 * - The window is **overlap-based with an inclusive `date_to`**: an entry that
 *   began before `date_from` but ran into it is returned, and so is one that
 *   begins exactly at `date_to`. Entries are therefore re-filtered on `start`
 *   into `[from, to)`, which is what "the entries for that day" means.
 * - **Planned entries come back too** — calendar events and scheduled blocks
 *   with no `start` and no `duration`. They are not tracked time, so they are
 *   dropped and counted, never listed as running timers.
 * - **The embedded project has no client**, so when any entry has a project
 *   the project list is read once (one more request) to name the clients.
 *
 * `include_taskless=true` is load-bearing: entries logged without a task —
 * every Track-migrated entry, and anything typed straight into the timer — are
 * dropped unless asked for.
 */
export const getTimeEntries = tool({
  name: 'get_time_entries',
  title: 'Toggl: Get time entries',
  description:
    'Get Toggl 2.0 time entries for a period or explicit date range, resolved to project, client, task and tag names, with a per-client duration roll-up. Good for invoicing and weekly reviews: ask for a range, get named entries plus totals. Breaks are left out unless include_breaks is set; planned (untracked) entries are left out and counted; a running entry is listed but never counted. One request, two when clients need naming.',
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
      .describe('Range start, YYYY-MM-DD (inclusive, in time_zone). Ignored when period is set.'),
    end_date: z
      .string()
      .optional()
      .describe('Range end, YYYY-MM-DD (exclusive, in time_zone). Ignored when period is set.'),
    time_zone: z
      .string()
      .default('UTC')
      .describe(
        'IANA time zone deciding which calendar day a period or date means, e.g. America/Vancouver. Defaults to UTC.',
      ),
    workspace_id: z
      .number()
      .int()
      .optional()
      .describe('Workspace to read. Defaults to the configured or current workspace.'),
    project_id: z.number().int().optional().describe('Only entries on this project.'),
    user_id: z
      .number()
      .int()
      .optional()
      .describe(
        'Only entries belonging to this Toggl user id, when the key can see more than your own.',
      ),
    billable_only: z.boolean().default(false).describe('Only entries marked billable.'),
    include_breaks: z
      .boolean()
      .default(false)
      .describe('Also return entries of type "break". Off by default: breaks are not work.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const { period, start_date, end_date, time_zone, workspace_id } = args;
    // Resolve the window before redeeming the secret — a bad time zone or
    // date should fail without a vault round-trip or a quota unit spent.
    const { range, window } = resolveWindow({ period, start_date, end_date, time_zone }, ctx.now());

    const key = await ctx.requireSecret('TOGGL_API_KEY');
    const { scope, quota: scopeQuota } = await resolveScope(ctx, key, workspace_id);

    const params = new URLSearchParams({
      date_from: window.from,
      date_to: window.to,
      include_taskless: 'true',
      archived: 'false',
      order_by: 'start',
    });
    const { body, quota } = await togglGet<TogglEntry[]>(
      `${scopePath(scope)}/time-entries/stream?${params}`,
      'fetch time entries',
      ctx,
      key,
    );
    const raw = Array.isArray(body) ? body : [];
    const tracked = raw
      .filter(isTracked)
      .filter((e) => e.start >= window.from && e.start < window.to);
    const planned = raw.length - raw.filter(isTracked).length;

    // The stream's project object carries no client; one project-list read
    // names them all, and only when an entry actually has a project.
    let budget = quota ?? scopeQuota;
    let clients = clientLookup([]);
    if (tracked.some((e) => e.project_id || e.project)) {
      const pages = await fetchProjects(scope, ctx, key, { includeArchived: true });
      clients = clientLookup(pages.projects);
      budget = pages.quota ?? budget;
    }

    const entries = tracked
      .map((e) => hydrate(e, ctx.now(), clients))
      .filter(matching(args))
      .toSorted((a, b) => a.start.localeCompare(b.start));

    const totalSeconds = entries.reduce((n, e) => n + (e.running ? 0 : e.duration), 0);
    const byClient = summarise(entries);

    const lines = entries.slice(0, LISTED).map((e) => entryLine(e));
    if (entries.length > LISTED) {
      lines.push(`… ${entries.length - LISTED} more in the structured result.`);
    }
    const rollup = byClient.map((c) => `  ${c.label}: ${fmtDuration(c.seconds)}`);
    const plural = entries.length === 1 ? 'y' : 'ies';
    const heading =
      `${entries.length} entr${plural} from ${range.start} to ${range.end} ` +
      `(end exclusive, ${time_zone}) · ${fmtDuration(totalSeconds)} tracked`;
    const skipped =
      planned > 0
        ? [`(${planned} planned, untracked entr${planned === 1 ? 'y' : 'ies'} left out.)`]
        : [];
    const text =
      entries.length > 0
        ? [heading, ...lines, '', 'By client:', ...rollup, ...skipped, ...quotaNote(budget)]
        : [
            `No time entries between ${range.start} and ${range.end}.`,
            ...skipped,
            ...quotaNote(budget),
          ];
    return {
      text: text.join('\n'),
      structured: {
        count: entries.length,
        totalSeconds,
        range,
        window,
        timeZone: time_zone,
        workspaceId: scope.workspaceId,
        byClient,
        entries,
        plannedSkipped: planned,
        quota: budget,
      },
    };
  },
});
