import { describe, expect, it } from 'vitest';
import { callTool, fetchMock, withSecret } from '../lib/test-harness.mjs';
import { parseBody, quotaNote, untilReset, upstreamMessage } from './client.ts';
import { dateRangeFor, zonedMidnight } from './dates.ts';
import { hydrate, isTracked } from './entries.ts';
import server from './extension.ts';

const KEY = 'toggl_sk_test_123';
const ORG = '4242';
const WS = '100';
const CONFIG = { organization_id: ORG, workspace_id: WS };
const BASE = 'https://focus.toggl.com/api';

const SETTINGS = { current_workspace_id: 100, timezone: 'America/Vancouver', start_week_on: 1 };

/**
 * Entries as `/time-entries/stream` serialises them — the live shape, not the
 * document's: the embedded `project` carries NO client (only the project list
 * does), a running entry has `start` but no `duration`, and PLANNED entries
 * (calendar events, scheduled blocks) come back with neither `start` nor
 * `duration`, only `planned_start`/`planned_duration`. Raw JSON so the `null`s
 * the API really sends survive into the fixture. The last two entries sit
 * outside the window the tests ask for (one began the day before and ran into
 * it, one begins exactly at the exclusive end) — the live filter returns both.
 */
const ENTRIES_JSON = `[
  { "id": 1, "description": "Schema work", "duration": 5400, "start": "2026-07-24T16:00:00Z",
    "billable": true, "billable_source": "task_default", "type": "activity", "workspace_id": 100,
    "project_id": 900, "project": { "id": 900, "name": "Orion", "color": "#f00", "private": false,
    "is_template": false, "draft": false, "permissions": null },
    "task_id": 55, "task": { "id": 55, "name": "Migration" }, "tag_ids": [5],
    "tags": [{ "id": 5, "name": "deep-work", "color": "#0f0" }], "toggl_user_id": 42,
    "timezone": "America/Vancouver", "planned_start": null, "planned_duration": null },
  { "id": 2, "description": "  ", "duration": 900, "start": "2026-07-24T18:00:00Z",
    "billable": false, "type": "activity", "workspace_id": 100, "project_id": 901,
    "project": { "id": 901, "name": "Internal", "color": "#00f" }, "task_id": null, "task": null,
    "tag_ids": null, "tags": [], "toggl_user_id": 42 },
  { "id": 3, "description": "Lunch", "duration": 1800, "start": "2026-07-24T19:00:00Z",
    "billable": false, "type": "break", "workspace_id": 100, "project_id": null, "project": null,
    "task_id": null, "task": null, "tags": [], "toggl_user_id": 42 },
  { "id": 4, "description": "Running timer", "duration": null, "start": "2026-07-24T20:00:00Z",
    "billable": false, "type": "activity", "workspace_id": 100, "project_id": null, "project": null,
    "task_id": null, "task": null, "tags": [], "toggl_user_id": 42 },
  { "id": 5, "description": "Teammate", "duration": 600, "start": "2026-07-24T21:00:00Z",
    "billable": true, "type": "activity", "workspace_id": 100, "project_id": 900,
    "project": { "id": 900, "name": "Orion", "color": "#f00" },
    "task_id": null, "task": null, "tags": [], "toggl_user_id": 43 },
  { "id": 6, "description": "Pick up the kids", "duration": null, "start": null,
    "planned_start": "2026-07-24T23:45:00Z", "planned_duration": 2700, "planned_at": "2026-07-20T16:22:01Z",
    "calendar_event_id": 926424033, "billable": false, "type": "activity", "workspace_id": 100,
    "project_id": null, "project": null, "task_id": null, "task": null, "tags": [], "toggl_user_id": 42 },
  { "id": 7, "description": "Late night before", "duration": 3600, "start": "2026-07-23T23:30:00Z",
    "billable": true, "type": "activity", "workspace_id": 100, "project_id": 900,
    "project": { "id": 900, "name": "Orion" }, "tags": [], "toggl_user_id": 42 },
  { "id": 8, "description": "Starts at the exclusive end", "duration": 60, "start": "2026-07-25T00:00:00Z",
    "billable": true, "type": "activity", "workspace_id": 100, "project_id": 900,
    "project": { "id": 900, "name": "Orion" }, "tags": [], "toggl_user_id": 42 }
]`;

/** The day the fixtures fall on, as an explicit range (period would resolve to the real today). */
const DAY = { start_date: '2026-07-24', end_date: '2026-07-25', time_zone: 'UTC' };

const PROJECTS = {
  data: [
    {
      id: 900,
      name: 'Orion',
      client: { id: 7, name: 'Northwind' },
      client_id: 7,
      billable: true,
      archived_at: null,
      total_tracked_secs: 36_000,
    },
    {
      id: 901,
      name: 'Internal',
      client: null,
      client_id: null,
      billable: false,
      archived_at: null,
    },
    {
      id: 902,
      name: 'Old',
      client: null,
      client_id: null,
      archived_at: '2026-01-01T00:00:00Z',
      total_tracked_secs: 60,
    },
  ],
  page: 1,
  per_page: 100,
  total: 3,
};

/** The quota headers Toggl 2.0 sends on every answer. */
const QUOTA = { 'x-toggl-quota-remaining': '27', 'x-toggl-quota-resets-in': '1800' };

/** Responder covering every endpoint the toolkit may touch. */
function togglApi(overrides = {}) {
  return (url) => {
    if (url.includes(`/organizations/${ORG}/workspaces/${WS}/time-entries/stream`)) {
      return overrides.entries ?? { text: ENTRIES_JSON, headers: QUOTA };
    }
    if (url.includes(`/organizations/${ORG}/workspaces/${WS}/tracking/current`)) {
      return overrides.current ?? new Response(null, { status: 204, headers: QUOTA });
    }
    if (url.includes(`/organizations/${ORG}/workspaces/${WS}/projects/900`)) {
      return { json: PROJECTS.data[0], headers: QUOTA };
    }
    if (url.includes(`/organizations/${ORG}/workspaces/${WS}/projects`)) {
      return overrides.projects ?? { json: PROJECTS, headers: QUOTA };
    }
    if (url.endsWith('/users/me/settings'))
      return overrides.settings ?? { json: SETTINGS, headers: QUOTA };
    throw new Error(`unexpected request: ${url}`);
  };
}

/**
 * {@link callTool}, with the toolkit settings the SDK hands a configured
 * server — `callTool` itself takes none, and every entry-level tool here
 * needs the organization id to address a request at all.
 */
async function call(tool, args, responder, config = CONFIG) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchMock(withSecret(KEY, responder ?? togglApi()));
  try {
    return await server.handle({
      tool,
      args,
      config,
      ctxToken: 'test-ctx-token',
      callbackBase: 'https://callback.test',
      userId: 'test-user',
      scopes: [],
    });
  } finally {
    globalThis.fetch = saved;
  }
}

describe('toggl MCP server', () => {
  it('lists the four tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'check_auth',
      'get_current_timer',
      'get_time_entries',
      'list_projects',
    ]);
  });

  it('marks every tool read-only', () => {
    for (const tool of server.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('declares the Toggl 2.0 host, key and ids', () => {
    expect(server.manifest).toMatchObject({
      secrets: ['TOGGL_API_KEY'],
      egress: ['focus.toggl.com'],
    });
    expect(Object.keys(server.manifest.config)).toEqual(['organization_id', 'workspace_id']);
  });

  describe('client helpers', () => {
    it('reads the error_description Toggl puts in its error body', () => {
      expect(
        upstreamMessage(
          '{"error":"invalid_session","error_description":"the provided API key is invalid","trace_id":"x"}',
        ),
      ).toBe('the provided API key is invalid');
      expect(upstreamMessage('{"error":"forbidden"}')).toBe('forbidden');
      expect(upstreamMessage('not json')).toBe('not json');
      expect(upstreamMessage(' '.repeat(3))).toBeUndefined();
    });

    it('parses one JSON document or newline-delimited JSON', () => {
      expect(parseBody('[{"id":1}]')).toEqual([{ id: 1 }]);
      expect(parseBody('{"id":1}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
      expect(parseBody('')).toBeUndefined();
      expect(() => parseBody('{nope')).toThrow();
    });

    it('formats the time until the quota resets', () => {
      expect(untilReset(1800)).toBe('30m');
      expect(untilReset(7260)).toBe('2h 1m');
      expect(untilReset(20)).toBe('1m');
      expect(untilReset(0)).toBeUndefined();
      expect(untilReset()).toBeUndefined();
    });

    it('warns only when the hourly budget is nearly spent', () => {
      expect(quotaNote({ remaining: 27, resetsIn: 1800 })).toEqual([]);
      expect(quotaNote()).toEqual([]);
      const [note] = quotaNote({ remaining: 2, resetsIn: 600 });
      expect(note).toMatch(/2 Toggl 2.0 API request\(s\) left this hour, resetting in 10m/);
    });

    it('tells a planned entry (no start) from a tracked one', () => {
      expect(
        isTracked({ id: 1, start: null, duration: null, planned_start: '2026-07-24T10:00:00Z' }),
      ).toBe(false);
      expect(isTracked({ id: 2, start: '2026-07-24T10:00:00Z', duration: null })).toBe(true);
      expect(isTracked({ id: 3 })).toBe(false);
    });

    it('treats a missing duration as a running entry and computes its elapsed time', () => {
      const now = new Date('2026-07-24T20:30:00Z');
      const running = hydrate({ id: 9, start: '2026-07-24T20:00:00Z', duration: null }, now);
      expect(running).toMatchObject({
        running: true,
        duration: 1800,
        stop: null,
        type: 'activity',
      });
      const stopped = hydrate({ id: 10, start: '2026-07-24T10:00:00Z', duration: 3600 }, now);
      expect(stopped).toMatchObject({
        running: false,
        duration: 3600,
        stop: '2026-07-24T11:00:00.000Z',
      });
    });
  });

  describe('dateRangeFor', () => {
    // 2026-07-24T05:00:00Z is still 2026-07-23 (22:00) in Vancouver.
    const lateNight = new Date('2026-07-24T05:00:00Z');

    it('resolves today in the caller time zone, not UTC', () => {
      expect(dateRangeFor('today', 'UTC', lateNight)).toEqual({
        start: '2026-07-24',
        end: '2026-07-25',
      });
      expect(dateRangeFor('today', 'America/Vancouver', lateNight)).toEqual({
        start: '2026-07-23',
        end: '2026-07-24',
      });
    });

    it('resolves yesterday', () => {
      expect(dateRangeFor('yesterday', 'UTC', lateNight)).toEqual({
        start: '2026-07-23',
        end: '2026-07-24',
      });
    });

    it('starts weeks on Monday with an exclusive end', () => {
      // 2026-07-24 UTC is a Friday; that week runs Mon 20th → Mon 27th.
      expect(dateRangeFor('week', 'UTC', lateNight)).toEqual({
        start: '2026-07-20',
        end: '2026-07-27',
      });
      expect(dateRangeFor('lastWeek', 'UTC', lateNight)).toEqual({
        start: '2026-07-13',
        end: '2026-07-20',
      });
    });

    it('handles a Sunday without rolling into the next week', () => {
      const sunday = new Date('2026-07-26T12:00:00Z');
      expect(dateRangeFor('week', 'UTC', sunday)).toEqual({
        start: '2026-07-20',
        end: '2026-07-27',
      });
    });

    it('resolves calendar months, including across a year boundary', () => {
      expect(dateRangeFor('month', 'UTC', lateNight)).toEqual({
        start: '2026-07-01',
        end: '2026-08-01',
      });
      const january = new Date('2026-01-15T12:00:00Z');
      expect(dateRangeFor('lastMonth', 'UTC', january)).toEqual({
        start: '2025-12-01',
        end: '2026-01-01',
      });
    });

    it('rejects a bogus time zone', () => {
      expect(() => dateRangeFor('today', 'Mars/Olympus', lateNight)).toThrow(/IANA time zone/);
    });
  });

  describe('zonedMidnight', () => {
    it("is the zone's own midnight, across DST", () => {
      expect(zonedMidnight('2026-07-24', 'UTC')).toBe('2026-07-24T00:00:00.000Z');
      // PDT is UTC-7 in July, PST is UTC-8 in January.
      expect(zonedMidnight('2026-07-24', 'America/Vancouver')).toBe('2026-07-24T07:00:00.000Z');
      expect(zonedMidnight('2026-01-15', 'America/Vancouver')).toBe('2026-01-15T08:00:00.000Z');
      // Half-hour zone, east of Greenwich.
      expect(zonedMidnight('2026-07-24', 'Asia/Kolkata')).toBe('2026-07-23T18:30:00.000Z');
    });

    it('rejects a non-date and a bogus zone', () => {
      expect(() => zonedMidnight('24/07/2026', 'UTC')).toThrow(/YYYY-MM-DD/);
      expect(() => zonedMidnight('2026-07-24', 'Mars/Olympus')).toThrow(/IANA time zone/);
    });
  });

  describe('check_auth', () => {
    it('reports the account, the configured organization and the quota', async () => {
      const result = await call('check_auth', {});
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({
        authenticated: true,
        organizationId: 4242,
        currentWorkspaceId: 100,
        timeZone: 'America/Vancouver',
        weekStartsOn: 'Monday',
        quota: { remaining: 27, resetsIn: 1800 },
      });
      expect(result.result.text).toContain('27 request(s) left this hour');
      expect(result.result.text).toContain('Organization id 4242 configured');
    });

    it('says the organization id is missing without failing', async () => {
      const result = await call('check_auth', {}, togglApi(), {});
      expect(result.ok).toBe(true);
      expect(result.result.structured.organizationId).toBeUndefined();
      expect(result.result.text).toMatch(/NOT configured/);
    });

    it('sends the key as a bearer token', async () => {
      let seen;
      await call('check_auth', {}, (url, init) => {
        seen = init?.headers;
        return togglApi()(url);
      });
      expect(new Headers(seen).get('authorization')).toBe(`Bearer ${KEY}`);
    });

    it('reports a rejected key as not authenticated', async () => {
      const result = await call(
        'check_auth',
        {},
        {
          status: 401,
          json: { error: 'invalid_session', error_description: 'the provided API key is invalid' },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({ authenticated: false });
    });

    it('does not report a spent quota as an auth failure', async () => {
      const result = await call(
        'check_auth',
        {},
        {
          status: 402,
          json: { error: 'quota_exceeded' },
          headers: { 'x-toggl-quota-remaining': '0', 'x-toggl-quota-resets-in': '1500' },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/hourly API quota/i);
      expect(result.error).toMatch(/25m/);
    });

    it('surfaces an outage as retryable', async () => {
      const result = await call('check_auth', {}, { status: 503, text: 'down' });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });

  describe('get_time_entries', () => {
    it('uses the embedded project, client, task and tag names', async () => {
      const result = await call('get_time_entries', DAY);
      expect(result.ok).toBe(true);
      const [first, second, running] = result.result.structured.entries;
      expect(first).toMatchObject({
        projectName: 'Orion',
        clientName: 'Northwind',
        taskName: 'Migration',
        billable: true,
        tags: ['deep-work'],
        userId: 42,
        stop: '2026-07-24T17:30:00.000Z',
      });
      // A project with no client hydrates the project but leaves client unset.
      expect(second.projectName).toBe('Internal');
      expect(second.clientName).toBeUndefined();
      expect(second.description).toBe('(no description)');
      // The running entry has no duration upstream and no project at all.
      expect(running).toMatchObject({ id: 4, running: true, stop: null });
      expect(running.projectName).toBeUndefined();
    });

    it('rolls up by client and counts neither the running entry nor breaks', async () => {
      const result = await call('get_time_entries', DAY);
      // 5400 + 900 + 600 = 6900s; the break (1800) and the running entry contribute nothing.
      expect(result.result.structured.count).toBe(4);
      expect(result.result.structured.totalSeconds).toBe(6900);
      expect(result.result.structured.byClient).toEqual([
        { label: 'Northwind', seconds: 6000 },
        { label: 'Internal', seconds: 900 },
      ]);
      expect(result.result.text).toContain('1h 55m tracked');
      expect(result.result.text).toContain('Northwind: 1h 40m');
      expect(result.result.text).not.toContain('Lunch');
    });

    it('includes breaks on request, still excluded from the roll-up', async () => {
      const result = await call('get_time_entries', { ...DAY, include_breaks: true });
      expect(result.result.structured.count).toBe(5);
      expect(result.result.structured.entries.find((e) => e.id === 3)).toMatchObject({
        type: 'break',
        duration: 1800,
      });
      expect(result.result.structured.totalSeconds).toBe(8700);
      expect(result.result.text).toContain('Lunch');
    });

    it('filters to billable entries only', async () => {
      const result = await call('get_time_entries', { ...DAY, billable_only: true });
      expect(result.result.structured.entries.map((e) => e.id)).toEqual([1, 5]);
    });

    it('filters by project and by user', async () => {
      const byProject = await call('get_time_entries', { ...DAY, project_id: 901 });
      expect(byProject.result.structured.entries.map((e) => e.id)).toEqual([2]);
      const byUser = await call('get_time_entries', { ...DAY, user_id: 43 });
      expect(byUser.result.structured.entries.map((e) => e.id)).toEqual([5]);
    });

    it("sends the zone's own midnights as the window, plus include_taskless", async () => {
      let seen = '';
      const result = await call(
        'get_time_entries',
        { start_date: '2026-07-01', end_date: '2026-08-01', time_zone: 'America/Vancouver' },
        (url) => {
          if (url.includes('/time-entries/stream')) {
            seen = url;
            return { json: [] };
          }
          return togglApi()(url);
        },
      );
      expect(result.ok).toBe(true);
      const params = new URL(seen).searchParams;
      expect(params.get('date_from')).toBe('2026-07-01T07:00:00.000Z');
      expect(params.get('date_to')).toBe('2026-08-01T07:00:00.000Z');
      expect(params.get('include_taskless')).toBe('true');
      expect(params.get('archived')).toBe('false');
      expect(result.result.structured.range).toEqual({ start: '2026-07-01', end: '2026-08-01' });
      expect(result.result.structured.window).toEqual({
        from: '2026-07-01T07:00:00.000Z',
        to: '2026-08-01T07:00:00.000Z',
      });
      expect(result.result.text).toMatch(/No time entries/);
    });

    it('reads a newline-delimited stream too', async () => {
      const lines = JSON.parse(ENTRIES_JSON)
        .map((e) => JSON.stringify(e))
        .join('\n');
      const result = await call('get_time_entries', DAY, togglApi({ entries: { text: lines } }));
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(4);
    });

    it('spends nothing on scope when both ids are configured: entries, then clients', async () => {
      const touched = [];
      await call('get_time_entries', DAY, (url) => {
        touched.push(url);
        return togglApi()(url);
      });
      const toggl = touched.filter((u) => u.startsWith(BASE));
      expect(toggl).toHaveLength(2);
      expect(toggl[0]).toContain('/time-entries/stream');
      expect(toggl[1]).toContain('/projects?');
      expect(toggl.some((u) => u.endsWith('/users/me/settings'))).toBe(false);
    });

    it('skips the project list when no entry has a project', async () => {
      const touched = [];
      const result = await call('get_time_entries', DAY, (url) => {
        touched.push(url);
        if (url.includes('/time-entries/stream')) {
          return {
            text: `[{ "id": 9, "description": "x", "duration": 60, "start": "2026-07-24T10:00:00Z",
              "project_id": null, "project": null, "tags": [] }]`,
          };
        }
        return togglApi()(url);
      });
      expect(result.ok).toBe(true);
      expect(touched.filter((u) => u.startsWith(BASE))).toHaveLength(1);
      expect(result.result.structured.byClient).toEqual([{ label: 'Unassigned', seconds: 60 }]);
    });

    it('names clients from the project list, since the stream embeds none', async () => {
      const result = await call('get_time_entries', DAY);
      const [first, second] = result.result.structured.entries;
      expect(first).toMatchObject({ projectName: 'Orion', clientId: 7, clientName: 'Northwind' });
      expect(second).toMatchObject({ projectName: 'Internal' });
      expect(second.clientName).toBeUndefined();
    });

    it('leaves planned (untracked) entries out and counts them', async () => {
      const result = await call('get_time_entries', DAY);
      expect(result.result.structured.entries.map((e) => e.id)).not.toContain(6);
      expect(result.result.structured.plannedSkipped).toBe(1);
      expect(result.result.text).toContain('(1 planned, untracked entry left out.)');
    });

    it('re-filters the overlap-based, inclusive-end window onto [start, end)', async () => {
      const result = await call('get_time_entries', DAY);
      const ids = result.result.structured.entries.map((e) => e.id);
      // 7 began the day before and ran into the window; 8 begins exactly at the end.
      expect(ids).not.toContain(7);
      expect(ids).not.toContain(8);
      expect(ids).toEqual([1, 2, 4, 5]);
    });

    it('falls back to the current workspace when none is configured', async () => {
      const touched = [];
      const result = await call(
        'get_time_entries',
        DAY,
        (url) => {
          touched.push(url);
          return togglApi()(url);
        },
        { organization_id: ORG },
      );
      expect(result.ok).toBe(true);
      expect(touched.some((u) => u.endsWith('/users/me/settings'))).toBe(true);
      expect(result.result.structured.workspaceId).toBe(100);
    });

    it('prefers an explicit workspace_id over the configured one', async () => {
      let seen = '';
      await call('get_time_entries', { ...DAY, workspace_id: 555 }, (url) => {
        if (url.includes('/time-entries/stream')) {
          seen = url;
          return { json: [] };
        }
        return togglApi()(url);
      });
      expect(seen).toContain(`/organizations/${ORG}/workspaces/555/time-entries/stream`);
    });

    it('refuses to call out without an organization id', async () => {
      const touched = [];
      const result = await call(
        'get_time_entries',
        DAY,
        (url) => {
          touched.push(url);
          return togglApi()(url);
        },
        {},
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/organization_id/);
      expect(result.error).toMatch(/focus\.toggl\.com/);
      expect(touched.filter((u) => u.startsWith(BASE))).toHaveLength(0);
    });

    it('rejects a non-numeric organization id from the settings', async () => {
      const result = await call('get_time_entries', DAY, togglApi(), {
        organization_id: 'acme',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a Toggl id/);
    });

    it('rejects a half-given or malformed explicit range before calling out', async () => {
      const half = await call('get_time_entries', { start_date: '2026-06-01' }, () => {
        throw new Error('should not fetch');
      });
      expect(half.ok).toBe(false);
      expect(half.error).toMatch(/both start_date and end_date/);
      const bad = await call(
        'get_time_entries',
        { start_date: '01/06/2026', end_date: '2026-07-01' },
        () => {
          throw new Error('should not fetch');
        },
      );
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/YYYY-MM-DD/);
      const reversed = await call(
        'get_time_entries',
        { start_date: '2026-07-01', end_date: '2026-06-01' },
        () => {
          throw new Error('should not fetch');
        },
      );
      expect(reversed.ok).toBe(false);
      expect(reversed.error).toMatch(/after start_date/);
    });

    it('rejects a bogus time zone without calling out', async () => {
      const result = await callTool(server, 'get_time_entries', {
        period: 'today',
        time_zone: 'Mars/Olympus',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/IANA time zone/);
    });

    it('surfaces a spent quota as retryable, with the reset time', async () => {
      const result = await call(
        'get_time_entries',
        DAY,
        togglApi({
          entries: {
            status: 402,
            json: { error: 'quota_exceeded' },
            headers: { 'x-toggl-quota-remaining': '0', 'x-toggl-quota-resets-in': '600' },
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/10m/);
    });

    it('names a permission refusal, and the ids, on a 403', async () => {
      const result = await call(
        'get_time_entries',
        DAY,
        togglApi({
          entries: { status: 403, json: { error: 'forbidden', error_description: 'no access' } },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no access/);
      expect(result.error).toMatch(/organization\/workspace ids/);
    });

    it('warns when the hourly budget is nearly spent', async () => {
      const result = await call(
        'get_time_entries',
        DAY,
        togglApi({
          entries: { text: ENTRIES_JSON, headers: { 'x-toggl-quota-remaining': '4' } },
          projects: { json: PROJECTS, headers: { 'x-toggl-quota-remaining': '3' } },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toMatch(/BUDGET: 3 Toggl 2.0 API request/);
      expect(result.result.structured.quota).toEqual({ remaining: 3 });
    });

    it('never leaks the key into an error message', async () => {
      const result = await call(
        'get_time_entries',
        DAY,
        togglApi({ entries: { status: 500, text: 'boom' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).not.toContain(KEY);
    });
  });

  describe('get_current_timer', () => {
    it('reports nothing running on a 204', async () => {
      const result = await call('get_current_timer', {});
      expect(result.ok).toBe(true);
      expect(result.result.structured).toEqual({
        running: false,
        quota: { remaining: 27, resetsIn: 1800 },
      });
      expect(result.result.text).toMatch(/No timer running/);
    });

    it('names the running project with one extra request', async () => {
      const touched = [];
      const result = await call('get_current_timer', {}, (url) => {
        touched.push(url);
        return togglApi({
          current: {
            text: `{ "id": 77, "description": "Now", "duration": null, "start": "2026-07-24T20:00:00Z",
                "billable": true, "type": "activity", "project_id": 900, "tag_ids": null,
                "tags": [{ "id": 5, "name": "deep-work" }], "toggl_user_id": 42 }`,
            headers: QUOTA,
          },
        })(url);
      });
      expect(result.ok).toBe(true);
      expect(result.result.structured.running).toBe(true);
      expect(result.result.structured.entry).toMatchObject({
        id: 77,
        running: true,
        projectName: 'Orion',
        clientName: 'Northwind',
        tags: ['deep-work'],
        billable: true,
      });
      expect(result.result.structured.entry.duration).toBeGreaterThanOrEqual(0);
      expect(touched.filter((u) => u.startsWith(BASE))).toHaveLength(2);
      expect(result.result.text).toMatch(
        /Running for .* since 2026-07-24T20:00:00Z: Now \[Orion\] \(Northwind\)/,
      );
    });

    it('spends no request naming a project when there is none', async () => {
      const touched = [];
      const result = await call('get_current_timer', {}, (url) => {
        touched.push(url);
        return togglApi({
          current: {
            text: `{ "id": 78, "description": "Untethered", "duration": null,
                "start": "2026-07-24T20:00:00Z", "project_id": null, "tags": [] }`,
          },
        })(url);
      });
      expect(result.ok).toBe(true);
      expect(result.result.structured.entry.projectName).toBeUndefined();
      expect(touched.filter((u) => u.startsWith(BASE))).toHaveLength(1);
    });
  });

  describe('list_projects', () => {
    it('lists projects with client names and archived state', async () => {
      const result = await call('list_projects', {});
      expect(result.ok).toBe(true);
      expect(result.result.structured.total).toBe(3);
      expect(result.result.structured.projects).toEqual([
        {
          id: 900,
          name: 'Orion',
          clientId: 7,
          clientName: 'Northwind',
          billable: true,
          archived: false,
          completed: false,
          totalTrackedSeconds: 36_000,
        },
        {
          id: 901,
          name: 'Internal',
          clientId: undefined,
          clientName: undefined,
          billable: false,
          archived: false,
          completed: false,
          totalTrackedSeconds: undefined,
        },
        {
          id: 902,
          name: 'Old',
          clientId: undefined,
          clientName: undefined,
          billable: false,
          archived: true,
          completed: false,
          totalTrackedSeconds: 60,
        },
      ]);
      expect(result.result.text).toContain('Orion (900) — Northwind · 10h 0m');
      expect(result.result.text).toContain('Old (902) · 1m [archived]');
    });

    it('asks for archived projects with an empty archived flag, and passes the name filter', async () => {
      let seen = '';
      await call('list_projects', { include_archived: true, name: 'ori' }, (url) => {
        if (url.includes('/projects')) {
          seen = url;
          return { json: { data: [], total: 0 } };
        }
        return togglApi()(url);
      });
      const params = new URL(seen).searchParams;
      expect(params.get('archived')).toBe('');
      expect(params.get('name')).toBe('ori');
      expect(params.get('per_page')).toBe('100');
    });

    it('omits the archived flag by default', async () => {
      let seen = '';
      const result = await call('list_projects', {}, (url) => {
        if (url.includes('/projects')) {
          seen = url;
          return { json: { data: [], total: 0 } };
        }
        return togglApi()(url);
      });
      expect(new URL(seen).searchParams.has('archived')).toBe(false);
      expect(result.result.text).toMatch(/No projects found/);
    });

    it('follows total across pages of 100', async () => {
      const pages = [];
      const result = await call('list_projects', {}, (url) => {
        if (url.includes('/projects')) {
          const page = Number(new URL(url).searchParams.get('page'));
          pages.push(page);
          const data = Array.from({ length: page === 1 ? 100 : 20 }, (_, i) => ({
            id: (page - 1) * 100 + i + 1,
            name: `P${(page - 1) * 100 + i + 1}`,
          }));
          return { json: { data, page, per_page: 100, total: 120 } };
        }
        return togglApi()(url);
      });
      expect(result.ok).toBe(true);
      expect(pages).toEqual([1, 2]);
      expect(result.result.structured.projects).toHaveLength(120);
      expect(result.result.structured.truncated).toBe(false);
    });

    it('stops after five pages and says so', async () => {
      let pages = 0;
      const result = await call('list_projects', {}, (url) => {
        if (url.includes('/projects')) {
          pages += 1;
          const data = Array.from({ length: 100 }, (_, i) => ({ id: pages * 1000 + i, name: 'P' }));
          return { json: { data, page: pages, per_page: 100, total: 100_000 } };
        }
        return togglApi()(url);
      });
      expect(pages).toBe(5);
      expect(result.result.structured.projects).toHaveLength(500);
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.text).toMatch(/Stopped after 500/);
    });
  });
});
