import { describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

const ME = { id: 42, email: 'matt@example.com', fullname: 'Matt Helm' };

const WORKSPACES = [
  { id: 100, name: 'Hollyburn' },
  { id: 200, name: 'Personal' },
];

/**
 * Time entries exactly as Toggl serialises them — kept as raw JSON so the
 * `null`s the API really sends (`stop` on a running timer, an unassigned
 * `project_id`) survive into the fixture verbatim.
 */
const ENTRIES_JSON = `[
  {
    "id": 1,
    "description": "Trove connectors",
    "duration": 5400,
    "start": "2026-07-23T09:00:00Z",
    "stop": "2026-07-23T10:30:00Z",
    "workspace_id": 100,
    "project_id": 7
  },
  {
    "id": 2,
    "description": "  ",
    "duration": 900,
    "start": "2026-07-23T11:00:00Z",
    "stop": "2026-07-23T11:15:00Z",
    "workspace_id": 100,
    "project_id": null
  },
  {
    "id": 3,
    "description": "Running timer",
    "duration": -1,
    "start": "2026-07-23T12:00:00Z",
    "stop": null,
    "workspace_id": 100,
    "project_id": null
  }
]`;

/** Assert the Basic-auth header Toggl requires: base64("<token>:api_token"). */
function expectBasicAuth(init) {
  const header = new Headers(init?.headers).get('authorization');
  expect(header).toBe(`Basic ${btoa('tok-123:api_token')}`);
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

  it('authenticates with the documented Basic scheme', async () => {
    const result = await callTool(
      server,
      'check_auth',
      {},
      withSecret('tok-123', (url, init) => {
        expect(url).toBe('https://api.track.toggl.com/api/v9/me');
        expectBasicAuth(init);
        return { json: ME };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured).toMatchObject({ authenticated: true, id: 42 });
  });

  it('reports a rejected token as not authenticated', async () => {
    const result = await callTool(
      server,
      'check_auth',
      {},
      withSecret('tok-123', { status: 401, json: {} }),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.authenticated).toBe(false);
  });

  it('does not report a rate limit as an auth failure', async () => {
    const result = await callTool(
      server,
      'check_auth',
      {},
      withSecret('tok-123', { status: 429, text: 'slow down', headers: { 'retry-after': '3' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/rate limit/i);
    expect(result.error).toMatch(/3s/);
  });

  it('lists workspaces', async () => {
    const result = await callTool(
      server,
      'list_workspaces',
      {},
      withSecret('tok-123', (url, init) => {
        expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces');
        expectBasicAuth(init);
        return { json: WORKSPACES };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.workspaces).toEqual([
      { id: 100, name: 'Hollyburn' },
      { id: 200, name: 'Personal' },
    ]);
    expect(result.result.text).toContain('Hollyburn (100)');
  });

  it('handles an empty workspace list', async () => {
    const result = await callTool(
      server,
      'list_workspaces',
      {},
      withSecret('tok-123', { json: [] }),
    );
    expect(result.ok).toBe(true);
    expect(result.result.text).toBe('No workspaces found.');
  });

  it('summarises time entries and skips the running one in the total', async () => {
    const result = await callTool(
      server,
      'get_time_entries',
      {},
      withSecret('tok-123', (url) => {
        expect(url).toBe('https://api.track.toggl.com/api/v9/me/time_entries');
        return { text: ENTRIES_JSON };
      }),
    );
    expect(result.ok).toBe(true);
    // 5400s + 900s = 6300s = 1h 45m; the running (-1) entry contributes nothing.
    expect(result.result.structured.totalSeconds).toBe(6300);
    // The running timer's `stop: null` round-trips untouched.
    expect(result.result.structured.entries[2].stop).toBeNull();
    expect(result.result.text).toContain('1h 45m tracked');
    expect(result.result.text).toContain('(no description)');
    expect(result.result.text).toContain('running');
  });

  it('passes a date range through as query parameters', async () => {
    const result = await callTool(
      server,
      'get_time_entries',
      { start_date: '2026-07-01', end_date: '2026-07-24' },
      withSecret('tok-123', (url) => {
        expect(url).toContain('start_date=2026-07-01');
        expect(url).toContain('end_date=2026-07-24');
        return { json: [] };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result.structured.count).toBe(0);
  });

  it('surfaces a 429 on time entries as retryable', async () => {
    const result = await callTool(
      server,
      'get_time_entries',
      {},
      withSecret('tok-123', { status: 429, text: 'slow down' }),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/1 request per second/);
  });

  it('does not retry a rejected token', async () => {
    const result = await callTool(
      server,
      'list_workspaces',
      {},
      withSecret('tok-123', { status: 403, text: 'forbidden' }),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/TOGGL_API_TOKEN/);
  });

  it('retries a server error', async () => {
    const result = await callTool(
      server,
      'list_workspaces',
      {},
      withSecret('tok-123', { status: 503, text: 'down' }),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('never leaks the token into an error message', async () => {
    const result = await callTool(
      server,
      'list_workspaces',
      {},
      withSecret('tok-123', { status: 500, text: 'boom' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('tok-123');
  });
});
