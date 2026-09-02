import { defineToolkit } from '@ontrove/extend/toolkit';
import { checkAuth } from './tools/check-auth.ts';
import { getCurrentTimer } from './tools/get-current-timer.ts';
import { getTimeEntries } from './tools/get-time-entries.ts';
import { listProjects } from './tools/list-projects.ts';

/**
 * Toggl 2.0 time-tracking MCP server, hosted on Trove — a read-only window onto
 * the caller's own Toggl 2.0 account: whether the key works and how much of the
 * hourly budget is left, the timer running right now, time entries for a period
 * resolved to project, client, task and tag *names*, and the workspace's
 * project list for mapping names to ids. Each tool lives in its own module
 * under `tools/`, over the transport in `client.ts`, the organization/workspace
 * resolution in `scope.ts`, the calendar maths in `dates.ts` and the entry
 * shaping in `entries.ts`.
 *
 * Auth is Toggl 2.0's bearer API key, resolved per-invocation via
 * `ctx.requireSecret`; the only egress is focus.toggl.com.
 *
 * Every call is budgeted against a **per-hour quota** (30 on the Free plan), so
 * each tool is built to cost one request: the time-entry list embeds project,
 * client, task and tags, so nothing is looked up afterwards, and a toolkit with
 * both ids configured spends nothing on scope.
 *
 * Named periods are timezone-aware on purpose. This server runs in UTC, so a
 * naive "today" rolls over mid-afternoon for a Pacific user; `time_zone` decides
 * which calendar day is meant, and the API is sent that zone's own midnights.
 */

const ID_HINT =
  'The bare number from the Toggl 2.0 URL: focus.toggl.com/<organization id>/workspaces/<workspace id>/…';

export default defineToolkit({
  id: 'toggl',
  name: 'Toggl 2.0 Time Tracking',
  description:
    "Query Toggl 2.0 time entries, resolved to project/client/task/tag names, with named periods (today, week, lastMonth…), a per-client duration roll-up, the timer running now, and the workspace's projects. Requires a TOGGL_API_KEY secret (Toggl 2.0 profile → API key, toggl_sk_…) and the organization_id setting (first number in the Toggl 2.0 URL). Read-only; one request per call against Toggl's hourly quota, which it reports on every answer.",
  icon: '⏱️',
  version: '3.0.0',
  secrets: ['TOGGL_API_KEY'],
  egress: ['focus.toggl.com'],
  scopes: [],
  visibility: 'shared',
  config: {
    organization_id: {
      label: 'Organization id',
      type: 'text',
      pattern: '^[0-9]+$',
      placeholder: '1234567',
      hint: `${ID_HINT}. Required: the API offers no way to look it up with an API key.`,
    },
    workspace_id: {
      label: 'Default workspace id',
      type: 'text',
      pattern: '^[0-9]+$',
      placeholder: '7654321',
      hint: `${ID_HINT}. Optional: defaults to the workspace the account has open.`,
    },
  },
  tools: [checkAuth, getCurrentTimer, getTimeEntries, listProjects],
});
