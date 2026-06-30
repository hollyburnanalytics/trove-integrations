import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';

/**
 * Canada Open Data — a no-auth hosted MCP server over the Government of Canada's
 * open-data portal (open.canada.ca), which runs CKAN and federates ~47k
 * datasets (federal + provincial/territorial).
 *
 * Four read-only surfaces:
 *  - `search_datasets` — find datasets by text + filters (department, format,
 *    jurisdiction, collection), returning titles, formats, and landing URLs,
 *  - `get_dataset` — full metadata + every resource's download URL/format,
 *  - `query_dataset` — pull actual rows for resources loaded into the CKAN
 *    DataStore (a subset; the rest are file links from get_dataset), and
 *  - `find_organizations` — resolve a department name to its filter slug.
 *
 * No API key. The portal is bilingual ({ en, fr }); English is surfaced. The
 * server only calls the CKAN API on open.canada.ca — resource files themselves
 * live off-portal (StatCan, NRCan, …) and are returned as URLs, not fetched.
 */

/** Base path for the open.canada.ca CKAN action API. */
const BASE_URL = 'https://open.canada.ca/data/api/3/action';

/** Descriptive User-Agent (open-data etiquette). Replace with your own contact before deploying. */
const CONTACT_EMAIL = 'trove-integrations@users.noreply.github.com';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

/** A CKAN response envelope: `{ success, result | error }`. */
type CkanEnvelope = { success?: boolean; result?: unknown; error?: unknown } | null;

/**
 * Map a CKAN error envelope (`{ success: false, error }`) to a non-retryable
 * {@link ToolError}, mirroring CKAN's own message. Returns `null` when the body
 * is not a recognizable success-false envelope.
 */
function ckanErrorFor(body: CkanEnvelope): ToolError | null {
  if (!body || typeof body !== 'object' || body.success) return null;
  const err = body.error as { message?: unknown; __type?: unknown } | undefined;
  const msg =
    (typeof err?.message === 'string' && err.message) ||
    (typeof err?.__type === 'string' && err.__type) ||
    'request rejected';
  return new ToolError(`Canada Open Data: ${msg}`, { retryable: false });
}

/**
 * GET a CKAN action and return its `result`. CKAN wraps every response in
 * `{ success, result | error }`; a `success: false` body (even with HTTP 200,
 * or on a 404/409) is surfaced as a non-retryable error. Other non-2xx is a
 * transient outage.
 */
async function ckanGet(
  action: string,
  params: URLSearchParams,
  ctx: Pick<ToolContext, 'fetchJson'>,
): Promise<unknown> {
  const body = (await ctx.fetchJson(`${BASE_URL}/${action}?${params}`, {
    init: { headers: { accept: 'application/json', 'user-agent': USER_AGENT } },
    // CKAN returns JSON error envelopes for 404 (not found) and 409 (validation);
    // parse those for a precise message. Other non-2xx is a transient outage.
    errorMap: (res, text) => {
      if (res.status !== 404 && res.status !== 409) {
        return new ToolError('open.canada.ca is temporarily unavailable.', { retryable: true });
      }
      let parsed: CkanEnvelope;
      try {
        parsed = JSON.parse(text) as CkanEnvelope;
      } catch {
        parsed = null;
      }
      return (
        ckanErrorFor(parsed) ??
        new ToolError('open.canada.ca returned malformed data; try again shortly.', {
          retryable: true,
        })
      );
    },
  })) as CkanEnvelope;
  if (!body || typeof body !== 'object') {
    throw new ToolError('open.canada.ca returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const envelopeError = ckanErrorFor(body);
  if (envelopeError) throw envelopeError;
  return body.result;
}

/** Resolve a CKAN localized field (`{ en, fr }` or string) to English. */
function en(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const e = (value as { en?: unknown }).en;
    if (typeof e === 'string' && e.length > 0) return e;
  }
  return null;
}

/** The English half of a bilingual "English | Français" org/title string. */
function englishHalf(value: unknown): string | null {
  const s = en(value);
  return s ? (s.split('|')[0] ?? s).trim() : null;
}

/** Human dataset landing page from its CKAN name (slug). */
function landingUrl(name: unknown): string | null {
  return typeof name === 'string' ? `https://open.canada.ca/data/en/dataset/${name}` : null;
}

/** Distinct, upper-cased resource formats on a dataset. */
function datasetFormats(resources: unknown): string[] {
  if (!Array.isArray(resources)) return [];
  const set = new Set<string>();
  for (const r of resources) {
    const f = (r as { format?: unknown }).format;
    if (typeof f === 'string' && f.length > 0) set.add(f.toUpperCase());
  }
  return [...set];
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_datasets',
      title: 'Canada Data: Search',
      description:
        'Search Government of Canada open datasets by text and filters. Filter by ' +
        'department slug (use find_organizations), resource format (CSV, GEOJSON, ' +
        'XLSX, JSON, SHP, …), jurisdiction (federal default / provincial / ' +
        "municipal / any), and collection. Returns each dataset's title, " +
        'department, available formats, landing-page URL, and slug (pass the slug ' +
        'to get_dataset). Sort by relevance or most-recently-updated.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .optional()
          .describe('Free-text query, e.g. "housing starts". Omit to browse by filters.'),
        organization: z
          .string()
          .optional()
          .describe('Department slug, e.g. "statcan", "cmhc", "nrcan-rncan", "bc".'),
        format: z.string().optional().describe('Resource format, e.g. "CSV", "GEOJSON", "XLSX".'),
        jurisdiction: z
          .enum(['federal', 'provincial', 'municipal', 'any'])
          .default('federal')
          .describe('Government level. Defaults to federal.'),
        collection: z
          .string()
          .optional()
          .describe('CKAN collection, e.g. "primary", "publication", "fgp" (geospatial).'),
        sort: z.enum(['relevance', 'recent']).default('relevance').describe('Result ordering.'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max datasets (1–25).'),
      }),
      output: z.object({
        total: z.number(),
        count: z.number(),
        datasets: z.array(
          z.object({
            slug: z.string().nullable(),
            title: z.string(),
            organization: z.string().nullable(),
            formats: z.array(z.string()),
            numResources: z.number(),
            modified: z.string().nullable(),
            landingUrl: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, organization, format, jurisdiction, collection, sort, limit } = args;
        const params = new URLSearchParams({
          q: query && query.length > 0 ? query : '*:*',
          rows: String(limit),
        });
        // open.canada.ca's CKAN mangles repeated `fq` params, so AND the filter
        // clauses into a single space-joined `fq` (Solr reads the join as AND).
        const fq: string[] = [];
        if (organization) fq.push(`organization:${organization}`);
        if (format) fq.push(`res_format:${format.toUpperCase()}`);
        if (jurisdiction !== 'any') fq.push(`jurisdiction:${jurisdiction}`);
        if (collection) fq.push(`collection:${collection}`);
        if (fq.length > 0) params.set('fq', fq.join(' '));
        if (sort === 'recent') params.set('sort', 'metadata_modified desc');
        ctx.log('search_datasets', { query, organization, format, jurisdiction, collection, sort });

        const result = (await ckanGet('package_search', params, ctx)) as {
          count?: number;
          results?: unknown[];
        };
        const rows = Array.isArray(result.results) ? result.results : [];
        const datasets = rows.map((r) => {
          const o = r as Record<string, unknown>;
          return {
            slug: typeof o.name === 'string' ? o.name : null,
            title: en(o.title_translated) ?? (typeof o.title === 'string' ? o.title : 'Untitled'),
            organization: englishHalf((o.organization as { title?: unknown } | undefined)?.title),
            formats: datasetFormats(o.resources),
            numResources: typeof o.num_resources === 'number' ? o.num_resources : 0,
            modified:
              typeof o.metadata_modified === 'string' ? o.metadata_modified.slice(0, 10) : null,
            landingUrl: landingUrl(o.name),
          };
        });
        const total = typeof result.count === 'number' ? result.count : datasets.length;
        if (datasets.length === 0) {
          return { text: 'No datasets matched.', structured: { total: 0, count: 0, datasets: [] } };
        }
        const lines = datasets
          .map(
            (d) =>
              `  ${d.title}${d.organization ? ` — ${d.organization}` : ''} [${d.formats.join(', ') || 'no files'}] (${d.slug})`,
          )
          .join('\n');
        return {
          text: `${datasets.length} of ${total} dataset(s):\n${lines}`,
          structured: { total, count: datasets.length, datasets },
        };
      },
    },
    {
      name: 'get_dataset',
      title: 'Canada Data: Get dataset',
      description:
        "Get a dataset's full metadata and every resource's download URL + format " +
        '(by slug or id from search_datasets). Each resource is flagged `queryable` ' +
        'when its rows can be fetched via query_dataset; otherwise use the URL.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('Dataset slug or id, e.g. "preliminary-housing-starts".'),
      }),
      output: z.object({
        title: z.string(),
        organization: z.string().nullable(),
        description: z.string().nullable(),
        landingUrl: z.string().nullable(),
        resources: z.array(
          z.object({
            name: z.string().nullable(),
            format: z.string().nullable(),
            url: z.string().nullable(),
            queryable: z.boolean(),
            resourceId: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_dataset', { id: args.id });
        const params = new URLSearchParams({ id: args.id });
        const o = (await ckanGet('package_show', params, ctx)) as Record<string, unknown>;
        const resources = Array.isArray(o.resources) ? o.resources : [];
        const projected = resources.map((r) => {
          const res = r as Record<string, unknown>;
          return {
            name: en(res.name),
            format: typeof res.format === 'string' ? res.format.toUpperCase() : null,
            url: typeof res.url === 'string' ? res.url : null,
            queryable: res.datastore_active === true,
            resourceId: typeof res.id === 'string' ? res.id : null,
          };
        });
        const title =
          en(o.title_translated) ?? (typeof o.title === 'string' ? o.title : 'Untitled');
        const description =
          en(o.notes_translated) ?? (typeof o.notes === 'string' ? o.notes : null);
        const lines = projected
          .map(
            (r) =>
              `  [${r.format ?? '?'}]${r.queryable ? ' (queryable)' : ''} ${r.name ?? ''} → ${r.url ?? '?'}`,
          )
          .join('\n');
        return {
          text: `"${title}" — ${projected.length} resource(s):\n${lines}`,
          structured: {
            title,
            organization: englishHalf((o.organization as { title?: unknown } | undefined)?.title),
            description: description ? description.replace(/\s+/g, ' ').slice(0, 400) : null,
            landingUrl: landingUrl(o.name),
            resources: projected,
          },
        };
      },
    },
    {
      name: 'query_dataset',
      title: 'Canada Data: Query rows',
      description:
        'Fetch actual rows from a resource that is loaded into the CKAN DataStore ' +
        '(use a resourceId from get_dataset where `queryable` is true). Optional ' +
        'free-text filter. Resources that are plain file links are not queryable — ' +
        'use their URL from get_dataset instead.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        resourceId: z
          .string()
          .min(1)
          .describe('Resource id (from get_dataset, queryable resources).'),
        q: z.string().optional().describe('Optional free-text row filter.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max rows (1–50).'),
      }),
      output: z.object({
        resourceId: z.string(),
        total: z.number(),
        fields: z.array(z.string()),
        records: z.array(z.record(z.unknown())),
      }),
      async handler(args, ctx) {
        const { resourceId, q, limit } = args;
        ctx.log('query_dataset', { resourceId, q, limit });
        const params = new URLSearchParams({ resource_id: resourceId, limit: String(limit) });
        if (q) params.set('q', q);
        let result: { total?: unknown; fields?: unknown; records?: unknown };
        try {
          result = (await ckanGet('datastore_search', params, ctx)) as typeof result;
        } catch (err) {
          // A non-DataStore resource yields a CKAN "not found" error — guide the
          // caller to the file URL instead of leaving an opaque failure.
          const msg = err instanceof ToolError ? err.message : 'lookup failed';
          throw new ToolError(
            `Resource ${resourceId} is not row-queryable (not in the DataStore). Use its download URL from get_dataset. (${msg})`,
            { retryable: false },
          );
        }
        const fields = Array.isArray(result.fields)
          ? result.fields
              .map((f) => (f as { id?: unknown }).id)
              .filter((id): id is string => typeof id === 'string' && id !== '_id')
          : [];
        const records = Array.isArray(result.records)
          ? (result.records as Array<Record<string, unknown>>)
          : [];
        const total = typeof result.total === 'number' ? result.total : records.length;
        if (records.length === 0) {
          return {
            text: `No rows in resource ${resourceId}.`,
            structured: { resourceId, total: 0, fields, records: [] },
          };
        }
        const preview = records
          .slice(0, 5)
          .map(
            (rec) =>
              `  ${fields
                .slice(0, 5)
                .map((f) => `${f}=${String(rec[f]).slice(0, 24)}`)
                .join(', ')}`,
          )
          .join('\n');
        return {
          text: `${records.length} of ${total} row(s) — fields: ${fields.join(', ')}\n${preview}`,
          structured: { resourceId, total, fields, records },
        };
      },
    },
    {
      name: 'find_organizations',
      title: 'Canada Data: Find department',
      description:
        'Resolve a department/organization name to the slug used by ' +
        'search_datasets (e.g. "Statistics Canada" → "statcan", "mortgage" → ' +
        '"cmhc-schl"). Returns matching organizations with their slugs.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .min(1)
          .describe('Department name or keyword, e.g. "statistics" or "health".'),
        limit: z.number().int().min(1).max(20).default(10).describe('Max matches (1–20).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        organizations: z.array(z.object({ slug: z.string(), title: z.string().nullable() })),
      }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('find_organizations', { query, limit });
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        const result = (await ckanGet('organization_autocomplete', params, ctx)) as unknown[];
        const organizations = (Array.isArray(result) ? result : []).flatMap((o) => {
          const org = o as { name?: unknown; title?: unknown };
          if (typeof org.name !== 'string') return [];
          return [{ slug: org.name, title: englishHalf(org.title) }];
        });
        if (organizations.length === 0) {
          return {
            text: `No departments matching "${query}".`,
            structured: { query, count: 0, organizations: [] },
          };
        }
        const lines = organizations.map((o) => `  ${o.slug} — ${o.title ?? ''}`).join('\n');
        return {
          text: `${organizations.length} department(s) for "${query}":\n${lines}`,
          structured: { query, count: organizations.length, organizations },
        };
      },
    },
  ],
});
