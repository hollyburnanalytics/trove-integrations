import { z } from '@ontrove/extend/toolkit';
import type { TogglEntry, TogglProjectLite } from './client.ts';

/**
 * Time entries as the tools present them: names attached, the running/stopped
 * split normalised, and the formatting the text mirrors share.
 */

/** A time entry with project, client, task and tag names attached. */
export interface HydratedEntry {
  id: number;
  description: string;
  start: string;
  /** Computed from `start + duration`; null while running. */
  stop: string | null;
  /** Seconds tracked; for a running entry, the seconds elapsed so far. */
  duration: number;
  running: boolean;
  billable: boolean;
  type: 'activity' | 'break';
  workspaceId?: number;
  projectId?: number;
  projectName?: string;
  clientId?: number;
  clientName?: string;
  taskId?: number;
  taskName?: string;
  tags: string[];
  /** The Toggl user the entry belongs to. */
  userId?: number;
  timeZone?: string;
}

/** The Zod twin of {@link HydratedEntry}, for the tools' `output` schemas. */
export const EntrySchema = z.object({
  id: z.number(),
  description: z.string(),
  start: z.string(),
  stop: z.string().nullable(),
  duration: z.number(),
  running: z.boolean(),
  billable: z.boolean(),
  type: z.enum(['activity', 'break']),
  workspaceId: z.number().optional(),
  projectId: z.number().optional(),
  projectName: z.string().optional(),
  clientId: z.number().optional(),
  clientName: z.string().optional(),
  taskId: z.number().optional(),
  taskName: z.string().optional(),
  tags: z.array(z.string()),
  userId: z.number().optional(),
  timeZone: z.string().optional(),
});

/** The quota, as the tools' `output` schemas carry it. */
export const QuotaSchema = z
  .object({ remaining: z.number().optional(), resetsIn: z.number().optional() })
  .optional();

/** A tracked or running entry — one with a `start`. See {@link TogglEntry}. */
export type TrackedEntry = TogglEntry & { start: string };

/**
 * Whether an entry has been tracked at all, as opposed to merely planned.
 *
 * The stream returns planned entries (calendar events, scheduled blocks) with
 * no `start`, and they would otherwise read as running timers that began at
 * an invalid date.
 */
export function isTracked(entry: TogglEntry): entry is TrackedEntry {
  return typeof entry.start === 'string' && entry.start.length > 0;
}

/** Project id → its client, from the project list; see {@link hydrate}. */
export type ClientLookup = ReadonlyMap<number, { id: number; name: string }>;

/** The client embedded on the project when there is one, else the lookup's. */
function resolveClient(
  project: TogglProjectLite | undefined,
  projectId: number | undefined,
  clients: ClientLookup | undefined,
): { id: number; name: string } | undefined {
  if (project?.client) return project.client;
  return projectId === undefined ? undefined : clients?.get(projectId);
}

/**
 * Attach names to a raw entry and normalise the running/stopped split.
 *
 * The workspace list embeds `project`, `task` and the effective `tags`, so
 * those cost nothing; the project's **client** it does not embed (whatever the
 * schema says), so `clients` — one project-list read per call — supplies it. A
 * running entry has no `duration`; its elapsed time is computed from `now` so
 * the caller sees something rather than null, and `running` says not to bill
 * it yet.
 */
export function hydrate(entry: TrackedEntry, now: Date, clients?: ClientLookup): HydratedEntry {
  const isRunning = entry.duration === undefined || entry.duration === null;
  const startMs = Date.parse(entry.start);
  const duration = isRunning
    ? Math.max(0, Math.round((now.getTime() - startMs) / 1000))
    : Math.max(0, entry.duration ?? 0);
  const stop =
    isRunning || Number.isNaN(startMs) ? null : new Date(startMs + duration * 1000).toISOString();
  const project = entry.project ?? undefined;
  const projectId = project?.id ?? entry.project_id ?? undefined;
  const client = resolveClient(project, projectId, clients);
  return {
    id: entry.id,
    description: entry.description?.trim() || '(no description)',
    start: entry.start,
    stop,
    duration,
    running: isRunning,
    billable: entry.billable === true,
    type: entry.type === 'break' ? 'break' : 'activity',
    workspaceId: entry.workspace_id,
    projectId,
    projectName: project?.name,
    clientId: client?.id,
    clientName: client?.name,
    taskId: entry.task?.id ?? entry.task_id ?? undefined,
    taskName: entry.task?.name ?? undefined,
    tags: (entry.tags ?? []).map((t) => t.name).filter(Boolean),
    userId: entry.toggl_user_id ?? undefined,
    timeZone: entry.timezone ?? undefined,
  };
}

/** Seconds → a compact `Hh Mm` label. */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** ` [Project] (Client)`, whichever of the two an entry has. */
export function whereLabel(e: Pick<HydratedEntry, 'projectName' | 'clientName'>): string {
  const project = e.projectName ? ` [${e.projectName}]` : '';
  const client = e.clientName ? ` (${e.clientName})` : '';
  return project + client;
}

/** One line of the entry listing. */
export function entryLine(e: HydratedEntry): string {
  const when = e.running
    ? `running ${fmtDuration(e.duration)}`
    : fmtDuration(e.duration).padStart(7);
  const marks = (e.billable ? ' 💲' : '') + (e.type === 'break' ? ' ☕' : '');
  return `• ${e.start.slice(0, 10)} ${when} — ${e.description}${whereLabel(e)}${marks}`;
}

/** Roll up a hydrated batch by client (falling back to project, then "Unassigned"). */
export function summarise(entries: HydratedEntry[]): { label: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (e.running || e.duration <= 0) continue;
    const label = e.clientName ?? e.projectName ?? 'Unassigned';
    totals.set(label, (totals.get(label) ?? 0) + e.duration);
  }
  return [...totals]
    .map(([label, seconds]) => ({ label, seconds }))
    .toSorted((a, b) => b.seconds - a.seconds);
}

/** The entry filters of `get_time_entries`, as given. */
export interface EntryFilters {
  project_id?: number;
  user_id?: number;
  billable_only: boolean;
  include_breaks: boolean;
}

/** A predicate applying every entry filter the caller set. */
export function matching({ project_id, user_id, billable_only, include_breaks }: EntryFilters) {
  return (e: HydratedEntry): boolean =>
    (include_breaks || e.type !== 'break') &&
    (project_id === undefined || e.projectId === project_id) &&
    (user_id === undefined || e.userId === user_id) &&
    (!billable_only || e.billable);
}
