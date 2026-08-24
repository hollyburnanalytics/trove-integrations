import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';

/**
 * Transport, lookup hydration and date-range maths for the Toggl Track API.
 *
 * Auth is Toggl's documented Basic scheme — the personal API token as the
 * username, the literal `api_token` as the password.
 *
 * Rate limiting: Toggl runs a leaky bucket at roughly 1 request/second per token
 * per IP, counts every integration sharing that token against the same budget,
 * and makes backing off the client's job. A 429 is surfaced as a retryable error
 * carrying `retryAfter`; it is never reported as an auth failure.
 */

const TOGGL = 'https://api.track.toggl.com/api/v9';

/** Toggl Basic-auth header: `base64("<token>:api_token")`. */
export function authHeader(token: string): string {
  const credentials = btoa(`${token}:api_token`);
  return `Basic ${credentials}`;
}

/** `Retry-After` in seconds, when Toggl sends one (it may be absent on 429). */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Map a non-2xx Toggl response to a model-safe ToolError.
 *
 * 429 and 5xx are retryable; 401/403 are not — a bad or revoked token will not
 * fix itself.
 */
export function togglError(what: string, response: Response): ToolError {
  if (response.status === 429) {
    const after = retryAfterSeconds(response);
    return new ToolError(
      `Toggl rate limit reached (it allows about 1 request per second per token). Wait ${
        after ? `${after}s` : 'a second'
      } and try again.`,
      { retryable: true, data: { retryAfter: after } },
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new ToolError(
      `Toggl rejected the API token (HTTP ${response.status}). Check the TOGGL_API_TOKEN secret.`,
      { retryable: false },
    );
  }
  return new ToolError(`Failed to ${what} (HTTP ${response.status}).`, {
    retryable: response.status >= 500,
  });
}

/** GET a Toggl endpoint as JSON, with the shared error mapping applied. */
export async function togglJson(
  path: string,
  what: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
  token: string,
): Promise<unknown> {
  return ctx.fetchJson(`${TOGGL}${path}`, {
    init: { headers: { accept: 'application/json', Authorization: authHeader(token) } },
    errorMap: (response) => togglError(what, response),
  });
}

export interface TogglMe {
  id: number;
  email: string;
  fullname: string;
}
export interface TogglWorkspace {
  id: number;
  name: string;
}
export interface TogglProject {
  id: number;
  name: string;
  client_id?: number | null;
  workspace_id: number;
}
export interface TogglClient {
  id: number;
  name: string;
}
export interface TogglTag {
  id: number;
  name: string;
}
export interface TogglEntry {
  id: number;
  description: string | null;
  duration: number;
  start: string;
  stop: string | null;
  billable?: boolean;
  workspace_id: number;
  project_id: number | null;
  task_id?: number | null;
  tag_ids?: number[];
}

/** A time entry with workspace/project/client/tag names resolved. */
export interface HydratedEntry {
  id: number;
  description: string;
  start: string;
  stop: string | null;
  duration: number;
  running: boolean;
  billable: boolean;
  workspaceId: number;
  workspaceName?: string;
  projectId?: number;
  projectName?: string;
  clientId?: number;
  clientName?: string;
  tags: string[];
}

/** Seconds → a compact `Hh Mm` label (running entries report negative duration). */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Mask an email for display: `matt@example.com` → `m***t@example.com`. */
export function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const [user, domain] = email.split('@', 2);
  if (!user || !domain) return '***';
  const masked = user.length <= 2 ? '*'.repeat(user.length) : `${user[0]}***${user.slice(-1)}`;
  return `${masked}@${domain}`;
}

export const PERIODS = ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth'] as const;
export type Period = (typeof PERIODS)[number];

/** Calendar Y/M/D of `now` as observed in `timeZone`. */
function calendarDay(now: Date, timeZone: string): { y: number; m: number; d: number } {
  let parts: string;
  try {
    // en-CA renders as YYYY-MM-DD.
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    throw new ToolError(
      `"${timeZone}" is not a recognised IANA time zone (e.g. America/Vancouver).`,
      {
        retryable: false,
      },
    );
  }
  const [y, m, d] = parts.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new ToolError(`Could not read a calendar date for time zone "${timeZone}".`, {
      retryable: false,
    });
  }
  return { y, m, d };
}

/** YYYY-MM-DD for a UTC-epoch day index, used for pure calendar arithmetic. */
function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

/**
 * Resolve a named period to Toggl's `[start_date, end_date)` pair — end always
 * exclusive, matching the API.
 *
 * The zone matters: this server runs in UTC, so "today" computed naively would
 * roll over mid-afternoon for a Pacific user. `timeZone` decides which calendar
 * day "today" means; the arithmetic itself is done on UTC day boundaries, which
 * is exact because only whole days are involved.
 */
export function dateRangeFor(
  period: Period,
  timeZone: string,
  now: Date,
): { start: string; end: string } {
  const { y, m, d } = calendarDay(now, timeZone);
  const today = Date.UTC(y, m - 1, d);

  switch (period) {
    case 'today': {
      return { start: iso(today), end: iso(today + DAY) };
    }
    case 'yesterday': {
      return { start: iso(today - DAY), end: iso(today) };
    }
    case 'week':
    case 'lastWeek': {
      // getUTCDay: 0=Sunday. Shift so Monday starts the week.
      const weekday = new Date(today).getUTCDay();
      const sinceMonday = (weekday + 6) % 7;
      const monday = today - sinceMonday * DAY - (period === 'lastWeek' ? 7 * DAY : 0);
      return { start: iso(monday), end: iso(monday + 7 * DAY) };
    }
    case 'month': {
      return { start: iso(Date.UTC(y, m - 1, 1)), end: iso(Date.UTC(y, m, 1)) };
    }
    case 'lastMonth': {
      return { start: iso(Date.UTC(y, m - 2, 1)), end: iso(Date.UTC(y, m - 1, 1)) };
    }
  }
}

/**
 * Resolve workspace/project/client/tag names for a batch of entries.
 *
 * Deliberately bulk, not per-entry: one `/projects` and one `/clients` call per
 * *referenced* workspace, then in-memory joins. The upstream plugin this ports
 * from resolved names one entry at a time behind a long-lived cache, which a
 * stateless hosted invocation cannot rely on — uncached that degrades to a call
 * per entry per workspace. Cost here is bounded at ~3 calls per workspace
 * regardless of how many entries came back, and each lookup is skipped entirely
 * when no entry needs it.
 */
/** The name lookup tables a batch of entries needs, keyed by upstream id. */
interface Lookups {
  workspaces: Map<number, string>;
  projects: Map<number, TogglProject>;
  clients: Map<number, string>;
  tags: Map<number, string>;
}

/**
 * Fetch one sub-collection across every referenced workspace, handing each item
 * to `add`. The three lookup tables differ only in path and how they index, so
 * they share this loop.
 */
async function collectPerWorkspace<T>(
  workspaceIds: number[],
  collection: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
  token: string,
  add: (item: T) => void,
): Promise<void> {
  for (const wid of workspaceIds) {
    const list = (await togglJson(
      `/workspaces/${wid}/${collection}`,
      `list ${collection}`,
      ctx,
      token,
    )) as T[] | undefined;
    const items = list ?? [];
    for (const item of items) add(item);
  }
}

/** Fetch every lookup table the batch actually references — and nothing else. */
async function fetchLookups(
  entries: TogglEntry[],
  ctx: Pick<ToolContext, 'fetchJson'>,
  token: string,
): Promise<Lookups> {
  const ids = [...new Set(entries.map((e) => e.workspace_id))];
  const lookups: Lookups = {
    workspaces: new Map(),
    projects: new Map(),
    clients: new Map(),
    tags: new Map(),
  };
  if (ids.length === 0) return lookups;

  const all = (await togglJson('/workspaces', 'list workspaces', ctx, token)) as
    | TogglWorkspace[]
    | undefined;
  const workspaces = all ?? [];
  for (const w of workspaces) lookups.workspaces.set(w.id, w.name);

  if (entries.some((e) => e.project_id)) {
    await collectPerWorkspace<TogglProject>(ids, 'projects', ctx, token, (p) =>
      lookups.projects.set(p.id, p),
    );
  }
  if (entries.some((e) => e.tag_ids?.length)) {
    await collectPerWorkspace<TogglTag>(ids, 'tags', ctx, token, (t) =>
      lookups.tags.set(t.id, t.name),
    );
  }
  // Clients only matter when a referenced project actually carries one.
  if ([...lookups.projects.values()].some((p) => p.client_id)) {
    await collectPerWorkspace<TogglClient>(ids, 'clients', ctx, token, (c) =>
      lookups.clients.set(c.id, c.name),
    );
  }
  return lookups;
}

export async function hydrate(
  entries: TogglEntry[],
  ctx: Pick<ToolContext, 'fetchJson'>,
  token: string,
): Promise<HydratedEntry[]> {
  const { workspaces, projects, clients, tags } = await fetchLookups(entries, ctx, token);

  return entries.map((e) => {
    const project = e.project_id ? projects.get(e.project_id) : undefined;
    const clientId = project?.client_id ?? undefined;
    return {
      id: e.id,
      description: e.description?.trim() || '(no description)',
      start: e.start,
      stop: e.stop,
      duration: e.duration,
      running: e.duration < 0,
      billable: e.billable === true,
      workspaceId: e.workspace_id,
      workspaceName: workspaces.get(e.workspace_id),
      projectId: e.project_id ?? undefined,
      projectName: project?.name,
      clientId: clientId ?? undefined,
      clientName: clientId ? clients.get(clientId) : undefined,
      tags: (e.tag_ids ?? []).map((id) => tags.get(id)).filter((t): t is string => Boolean(t)),
    };
  });
}
