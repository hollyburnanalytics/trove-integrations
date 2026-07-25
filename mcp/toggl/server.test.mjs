import { describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import { dateRangeFor, maskEmail } from './client.ts';
import server from './server.ts';

const TOKEN = 'tok-123';
const ME = { id: 42, email: 'matt@example.com', fullname: 'Matt Helm' };
const WORKSPACES = [{ id: 100, name: 'Acme Analytics' }];
const PROJECTS = [
  { id: 900, name: 'Orion', client_id: 7, workspace_id: 100 },
  { id: 901, name: 'Internal', client_id: undefined, workspace_id: 100 },
];
const CLIENTS = [{ id: 7, name: 'Northwind' }];
const TAGS = [{ id: 5, name: 'deep-work' }];

/**
 * Entries exactly as Toggl serialises them — raw JSON so the `null`s the API
 * really sends (`stop` on a running timer, an unassigned `project_id`) survive
 * into the fixture verbatim.
 */
const ENTRIES_JSON = `[
  { "id": 1, "description": "Schema work", "duration": 5400, "start": "2026-07-24T16:00:00Z",
    "stop": "2026-07-24T17:30:00Z", "billable": true, "workspace_id": 100, "project_id": 900,
    "task_id": null, "tag_ids": [5] },
  { "id": 2, "description": "  ", "duration": 900, "start": "2026-07-24T18:00:00Z",
    "stop": "2026-07-24T18:15:00Z", "billable": false, "workspace_id": 100, "project_id": 901,
    "task_id": null, "tag_ids": [] },
  { "id": 3, "description": "Running timer", "duration": -1, "start": "2026-07-24T19:00:00Z",
    "stop": null, "billable": false, "workspace_id": 100, "project_id": null, "task_id": null }
]`;

/** Responder covering every endpoint get_time_entries may touch. */
function togglApi(overrides = {}) {
  return (url) => {
    if (url.includes('/me/time_entries')) return overrides.entries ?? { text: ENTRIES_JSON };
    if (url.includes('/workspaces/100/projects')) return { json: PROJECTS };
    if (url.includes('/workspaces/100/clients')) return { json: CLIENTS };
    if (url.includes('/workspaces/100/tags')) return { json: TAGS };
    if (url.endsWith('/workspaces')) return { json: WORKSPACES };
    if (url.endsWith('/me')) return { json: ME };
    throw new Error(`unexpected request: ${url}`);
  };
}

describe('toggl MCP server', () => {
  it('lists the three tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'check_auth',
      'get_time_entries',
      'list_workspaces',
    ]);
  });

  it('marks every tool read-only', () => {
    for (const tool of server.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  describe('maskEmail', () => {
    it('masks the local part but keeps the domain', () => {
      expect(maskEmail('matt@example.com')).toBe('m***t@example.com');
    });
    it('fully masks a very short local part', () => {
      expect(maskEmail('me@example.com')).toBe('**@example.com');
    });
    it('returns *** when there is no @', () => {
      expect(maskEmail('not-an-email')).toBe('***');
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

  describe('check_auth', () => {
    it('masks the email and includes workspaces', async () => {
      const result = await callTool(server, 'check_auth', {}, withSecret(TOKEN, togglApi()));
      expect(result.ok).toBe(true);
      expect(result.result.structured).toMatchObject({
        authenticated: true,
        id: 42,
        email: 'm***t@example.com',
      });
      expect(result.result.structured.workspaces).toEqual([{ id: 100, name: 'Acme Analytics' }]);
      expect(result.result.text).not.toContain('matt@example.com');
    });

    it('reports a rejected token as not authenticated', async () => {
      const result = await callTool(
        server,
        'check_auth',
        {},
        withSecret(TOKEN, { status: 401, json: {} }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.authenticated).toBe(false);
    });

    it('does not report a rate limit as an auth failure', async () => {
      const result = await callTool(
        server,
        'check_auth',
        {},
        withSecret(TOKEN, { status: 429, text: 'slow', headers: { 'retry-after': '3' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate limit/i);
      expect(result.error).toMatch(/3s/);
    });
  });

  describe('get_time_entries', () => {
    it('hydrates project, client and tag names', async () => {
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'today', time_zone: 'UTC' },
        withSecret(TOKEN, togglApi()),
      );
      expect(result.ok).toBe(true);
      const [first, second, third] = result.result.structured.entries;
      expect(first).toMatchObject({
        projectName: 'Orion',
        clientName: 'Northwind',
        billable: true,
        tags: ['deep-work'],
      });
      expect(first.workspaceName).toBe('Acme Analytics');
      // A project with no client hydrates the project but leaves client unset.
      expect(second.projectName).toBe('Internal');
      expect(second.clientName).toBeUndefined();
      expect(second.description).toBe('(no description)');
      // The running entry has no project at all.
      expect(third.running).toBe(true);
      expect(third.projectName).toBeUndefined();
    });

    it('rolls up by client and excludes the running entry from the total', async () => {
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'today' },
        withSecret(TOKEN, togglApi()),
      );
      // 5400 + 900 = 6300s; the running (-1) entry contributes nothing.
      expect(result.result.structured.totalSeconds).toBe(6300);
      expect(result.result.structured.byClient).toEqual([
        { label: 'Northwind', seconds: 5400 },
        { label: 'Internal', seconds: 900 },
      ]);
      expect(result.result.text).toContain('1h 45m tracked');
      expect(result.result.text).toContain('Northwind: 1h 30m');
    });

    it('filters to billable entries only', async () => {
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'today', billable_only: true },
        withSecret(TOKEN, togglApi()),
      );
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.entries[0].projectName).toBe('Orion');
    });

    it('filters by project', async () => {
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'today', project_id: 901 },
        withSecret(TOKEN, togglApi()),
      );
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.entries[0].projectName).toBe('Internal');
    });

    it('sends the resolved period as an exclusive date range', async () => {
      let seen = '';
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'week', time_zone: 'UTC' },
        withSecret(TOKEN, (url) => {
          if (url.includes('/me/time_entries')) {
            seen = url;
            return { json: [] };
          }
          return togglApi()(url);
        }),
      );
      expect(result.ok).toBe(true);
      expect(seen).toContain('start_date=');
      expect(seen).toContain('end_date=');
    });

    it('honours an explicit date range over the default period', async () => {
      let seen = '';
      await callTool(
        server,
        'get_time_entries',
        { start_date: '2026-06-01', end_date: '2026-07-01' },
        withSecret(TOKEN, (url) => {
          if (url.includes('/me/time_entries')) {
            seen = url;
            return { json: [] };
          }
          return togglApi()(url);
        }),
      );
      expect(seen).toContain('start_date=2026-06-01');
      expect(seen).toContain('end_date=2026-07-01');
    });

    it('skips project and tag lookups when no entry needs them', async () => {
      const touched = [];
      await callTool(
        server,
        'get_time_entries',
        { period: 'today' },
        withSecret(TOKEN, (url) => {
          touched.push(url);
          if (url.includes('/me/time_entries')) {
            // Raw JSON so the API's real nulls reach the code under test.
            return {
              text: `[{ "id": 9, "description": "x", "duration": 60,
                "start": "2026-07-24T10:00:00Z", "stop": null,
                "workspace_id": 100, "project_id": null }]`,
            };
          }
          if (url.endsWith('/workspaces')) return { json: WORKSPACES };
          throw new Error(`should not have fetched ${url}`);
        }),
      );
      expect(touched.some((u) => u.includes('/projects'))).toBe(false);
      expect(touched.some((u) => u.includes('/clients'))).toBe(false);
      expect(touched.some((u) => u.includes('/tags'))).toBe(false);
    });

    it('rejects a bogus time zone without calling out', async () => {
      const result = await callTool(server, 'get_time_entries', {
        period: 'today',
        time_zone: 'Mars/Olympus',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/IANA time zone/);
    });

    it('surfaces a 429 as retryable', async () => {
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'today' },
        withSecret(TOKEN, { status: 429, text: 'slow' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('never leaks the token into an error message', async () => {
      const result = await callTool(
        server,
        'get_time_entries',
        { period: 'today' },
        withSecret(TOKEN, { status: 500, text: 'boom' }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain(TOKEN);
    });
  });
});
