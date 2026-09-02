import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';
import { type Quota, type TogglUserSettings, togglGet } from './client.ts';

/**
 * Which organization and workspace a call addresses.
 *
 * Every entry-level Toggl 2.0 endpoint is `/organizations/{org}/workspaces/{ws}/…`,
 * and no endpoint an API key may call lists either: `/workspaces/{id}/context`,
 * which returns the organization for a workspace, is documented as
 * session-only ("API-key callers are rejected"), and organization membership
 * lives on `accounts.toggl.com`, a host this key does not reach. Both ids are
 * visible in the web app's address bar — `focus.toggl.com/<organization
 * id>/workspaces/<workspace id>/…` — so the organization is a toolkit setting,
 * and the workspace defaults to the one the account has open
 * (`current_workspace_id` on `/users/me/settings`, the one documented API-key
 * example call).
 */

/** The organization and workspace every entry-level endpoint is addressed by. */
export interface Scope {
  organizationId: number;
  workspaceId: number;
}

const ID = /^\d{1,20}$/;

/** A config value as an id, when it is one; `undefined` when unset. */
function configId(ctx: Pick<ToolContext, 'config'>, name: string): number | undefined {
  const stored = ctx.config?.[name];
  let raw = '';
  if (typeof stored === 'string') raw = stored.trim();
  else if (typeof stored === 'number') raw = String(stored);
  if (!raw) return undefined;
  if (!ID.test(raw)) {
    throw new ToolError(
      `The toolkit setting ${name} is "${raw}", which is not a Toggl id. Expected the bare number from the Toggl 2.0 URL (focus.toggl.com/<organization id>/workspaces/<workspace id>/…).`,
      { retryable: false },
    );
  }
  return Number(raw);
}

/** The organization id from the toolkit settings, or `undefined`. */
export function configuredOrganization(ctx: Pick<ToolContext, 'config'>): number | undefined {
  return configId(ctx, 'organization_id');
}

/** The error for "no organization id, and every entry endpoint needs one". */
export function noOrganizationError(): ToolError {
  return new ToolError(
    'No organization id configured. Set organization_id in the toolkit settings: it is the first number in the Toggl 2.0 URL, ' +
      'focus.toggl.com/<organization id>/workspaces/<workspace id>/… — the API offers no way to look it up with an API key.',
    { retryable: false },
  );
}

/**
 * Resolve the organization and workspace a call addresses.
 *
 * Organization: the toolkit setting, or an error that says where to find it.
 * Workspace: the argument, else the setting, else the workspace the account
 * has open (`/users/me/settings`, one request). Resolved in that order so a
 * fully configured toolkit spends nothing on scope.
 */
export async function resolveScope(
  ctx: Pick<ToolContext, 'config' | 'fetch'>,
  key: string,
  workspaceArg: number | undefined,
): Promise<{ scope: Scope; quota?: Quota }> {
  const organizationId = configuredOrganization(ctx);
  if (organizationId === undefined) throw noOrganizationError();

  const configured = workspaceArg ?? configId(ctx, 'workspace_id');
  if (configured !== undefined) return { scope: { organizationId, workspaceId: configured } };

  const { body, quota } = await togglGet<TogglUserSettings>(
    '/users/me/settings',
    'read the current workspace',
    ctx,
    key,
  );
  const current = body?.current_workspace_id;
  if (typeof current !== 'number') {
    throw new ToolError(
      'Toggl 2.0 reports no current workspace for this account. Pass workspace_id, or set it in the toolkit settings (the number after /workspaces/ in the Toggl 2.0 URL).',
      { retryable: false },
    );
  }
  return { scope: { organizationId, workspaceId: current }, quota };
}

/** The path prefix every organization-and-workspace-scoped endpoint shares. */
export function scopePath(scope: Scope): string {
  return `/organizations/${scope.organizationId}/workspaces/${scope.workspaceId}`;
}
