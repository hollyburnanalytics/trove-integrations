import type { ToolContext } from '@ontrove/extend/toolkit';
import { type Quota, type TogglProject, togglGet } from './client.ts';
import type { ClientLookup } from './entries.ts';
import { type Scope, scopePath } from './scope.ts';

/**
 * The workspace's project list, read once and paged as far as it goes.
 *
 * `per_page` is capped at **100** — the live API answers 200 with
 * `400 validation … 'PerPage' failed on the 'max' tag` — and the envelope is
 * `models.PageWithTotal`, so `total` says when a second page is needed. Pages
 * are bounded so a pathological workspace cannot spend the hour's quota on one
 * call; `truncated` says when the bound was hit.
 */

/** The largest page the projects endpoint accepts (verified live). */
export const PROJECT_PAGE = 100;

/** The most pages one call will read: 500 projects, five quota units. */
const MAX_PAGES = 5;

/** Options for {@link fetchProjects}. */
export interface ProjectQuery {
  /** Include archived projects alongside active ones. */
  includeArchived?: boolean;
  /** Only projects whose project or client name matches. */
  name?: string;
}

/** What {@link fetchProjects} returns: every project read, and the count Toggl claims. */
export interface ProjectPages {
  projects: TogglProject[];
  total: number;
  /** True when {@link MAX_PAGES} was reached before `total` was. */
  truncated: boolean;
  quota?: Quota;
}

/** Read the workspace's projects, following `total` across pages. */
export async function fetchProjects(
  scope: Scope,
  ctx: Pick<ToolContext, 'fetch'>,
  key: string,
  query: ProjectQuery = {},
): Promise<ProjectPages> {
  const projects: TogglProject[] = [];
  let total = 0;
  let quota: Quota | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ per_page: String(PROJECT_PAGE), page: String(page) });
    // The API reads an EMPTY `archived` as "all projects" and an omitted one as
    // "active only", so the flag is sent empty rather than as `true`, which
    // would return archived projects ONLY.
    if (query.includeArchived) params.set('archived', '');
    if (query.name) params.set('name', query.name);
    const result = await togglGet<{ data?: TogglProject[]; total?: number }>(
      `${scopePath(scope)}/projects?${params}`,
      'list projects',
      ctx,
      key,
    );
    const rows = result.body?.data ?? [];
    projects.push(...rows);
    total = result.body?.total ?? projects.length;
    quota = result.quota ?? quota;
    if (rows.length === 0 || projects.length >= total) {
      return { projects, total, truncated: false, quota };
    }
  }
  return { projects, total, truncated: true, quota };
}

/** Project id → client, for {@link hydrate} to fill in what the stream omits. */
export function clientLookup(projects: readonly TogglProject[]): ClientLookup {
  const lookup = new Map<number, { id: number; name: string }>();
  for (const p of projects) {
    if (p.client) lookup.set(p.id, { id: p.client.id, name: p.client.name });
  }
  return lookup;
}
