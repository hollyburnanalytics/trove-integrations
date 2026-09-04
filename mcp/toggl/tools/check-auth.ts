import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { authHeader, readQuota, type TogglUserSettings, togglError } from '../client.ts';
import { fmtDuration, QuotaSchema } from '../entries.ts';
import { configuredOrganization } from '../scope.ts';

/** `start_week_on` (0 = Sunday, 1 = Monday) as a word. */
const WEEK_START: Record<number, 'Sunday' | 'Monday'> = { 0: 'Sunday', 1: 'Monday' };

/**
 * `check_auth` — does the key work, and what is it pointed at.
 *
 * Reads `/users/me/settings`, the one API-key call Toggl's own authentication
 * page demonstrates. It is called through `ctx.fetch` rather than `togglGet`
 * because a 401 here is an *answer* ("not authenticated"), not a failure — and
 * because a spent quota or an outage says nothing about the key's validity,
 * those still throw, so a burst never looks like a bad key.
 */
export const checkAuth = tool({
  name: 'check_auth',
  title: 'Toggl: Check authentication',
  description:
    "Verify the Toggl 2.0 API key works and report the account's current workspace and time zone, whether the organization id is configured, and the hourly API quota left when Toggl reports it (a plain 200 carries no quota headers). One request.",
  input: z.object({}),
  output: z.object({
    authenticated: z.boolean(),
    organizationId: z.number().optional(),
    currentWorkspaceId: z.number().optional(),
    timeZone: z.string().optional(),
    weekStartsOn: z.enum(['Sunday', 'Monday']).optional(),
    quota: QuotaSchema,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(_args, ctx) {
    const key = await ctx.requireSecret('TOGGL_API_KEY');
    let response: Response;
    try {
      response = await ctx.fetch('https://focus.toggl.com/api/users/me/settings', {
        headers: { accept: 'application/json', Authorization: authHeader(key) },
      });
    } catch {
      throw new ToolError('Could not reach Toggl 2.0 to check authentication; try again shortly.', {
        retryable: true,
      });
    }
    const text = await response.text();
    if (response.status === 401) {
      return {
        text: 'Not authenticated — Toggl 2.0 rejected the API key (HTTP 401). Generate a key in the Toggl 2.0 profile settings and store it as TOGGL_API_KEY.',
        structured: { authenticated: false },
      };
    }
    if (!response.ok) throw togglError('check authentication', response, text);

    const settings = JSON.parse(text) as TogglUserSettings;
    const organizationId = configuredOrganization(ctx);
    const quota = readQuota(response);
    const currentWorkspaceId = settings.current_workspace_id ?? undefined;
    const timeZone = settings.timezone ?? undefined;
    const weekStartsOn = WEEK_START[settings.start_week_on ?? -1];

    const zone = timeZone ? `, time zone ${timeZone}` : '';
    const week = weekStartsOn ? `, weeks start on ${weekStartsOn}` : '';
    const lines = [
      `Authenticated with Toggl 2.0 — current workspace ${currentWorkspaceId ?? 'unknown'}${zone}${week}.`,
      organizationId === undefined
        ? 'Organization id NOT configured: set organization_id in the toolkit settings (first number in the Toggl 2.0 URL) before using the time-entry tools.'
        : `Organization id ${organizationId} configured.`,
    ];
    if (quota?.remaining !== undefined) {
      const back = quota.resetsIn ? `, resetting in ${fmtDuration(quota.resetsIn)}` : '';
      lines.push(`API quota: ${quota.remaining} request(s) left this hour${back}.`);
    }
    return {
      text: lines.join('\n'),
      structured: {
        authenticated: true,
        organizationId,
        currentWorkspaceId,
        timeZone,
        weekStartsOn,
        quota,
      },
    };
  },
});
