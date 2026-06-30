import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * openFDA — a no-auth hosted MCP server over the FDA's open data API
 * (api.fda.gov). Two read-only surfaces:
 *  - `search_drug_labels` — drug product labels (indications, warnings), and
 *  - `search_recalls` — food / drug / device recall enforcement reports.
 *
 * No API key (anonymous rate limits apply). Search uses openFDA's field-scoped
 * query syntax built from the caller's plain terms.
 */

/** Base host for the openFDA API. */
const BASE_URL = 'https://api.fda.gov';

/**
 * GET an openFDA URL and parse JSON. A 404 means "no matches" (empty result),
 * so this stays on raw `ctx.fetch` (the SDK still injects the default
 * User-Agent) — `fetchJson` would turn the 404 into a hard error.
 */
async function getResults(
  url: string,
  ctx: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> },
): Promise<Array<Record<string, unknown>>> {
  const res = await ctx.fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return []; // openFDA signals zero matches with 404
  if (res.status === 429) {
    throw new ToolError('openFDA rate limit hit; try again shortly.', { retryable: true });
  }
  if (!res.ok) {
    throw new ToolError('openFDA is temporarily unavailable.', { retryable: true });
  }
  const parsed = (await res.json().catch(() => null)) as { results?: unknown } | null;
  return parsed && Array.isArray(parsed.results)
    ? (parsed.results as Array<Record<string, unknown>>)
    : [];
}

/**
 * Build an openFDA `search` value that ORs a term across several fields, e.g.
 * `(brand_name:"x"+generic_name:"x")`. The TERM is URL-encoded (spaces → %20)
 * but the structural `+` / `:` / `()` / `"` stay literal — openFDA reads `+` as
 * its term separator, so the whole string must NOT be re-encoded by the caller.
 *
 * @param fields - openFDA field paths to OR over.
 * @param term - The user search term (quotes stripped).
 * @returns The ready-to-append `search` value.
 */
function fdaSearch(fields: string[], term: string): string {
  const t = encodeURIComponent(term.replace(/"/g, ''));
  return `(${fields.map((f) => `${f}:%22${t}%22`).join('+')})`;
}

/** First entry of a string-array openFDA field, or null. */
function first(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/** Truncate an openFDA narrative field (often a long single-element array). */
function snippet(value: unknown, max = 240): string | null {
  const text = Array.isArray(value) ? value.find((v) => typeof v === 'string') : value;
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_drug_labels',
      title: 'openFDA: Drug labels',
      description:
        'Search FDA drug product labels by brand or generic name (e.g. "Tylenol", ' +
        '"ibuprofen"). Returns brand/generic names, manufacturer, and snippets of ' +
        'the indications and warnings.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        name: z.string().min(1).describe('Brand or generic drug name, e.g. "Tylenol".'),
        limit: z.number().int().min(1).max(10).default(3).describe('Max labels (1–10).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        labels: z.array(
          z.object({
            brandName: z.string().nullable(),
            genericName: z.string().nullable(),
            manufacturer: z.string().nullable(),
            indications: z.string().nullable(),
            warnings: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { name, limit } = args;
        ctx.log('search_drug_labels', { name, limit });
        const search = fdaSearch(['openfda.brand_name', 'openfda.generic_name'], name);
        const url = `${BASE_URL}/drug/label.json?search=${search}&limit=${limit}`;
        const results = await getResults(url, ctx);
        const labels = results.map((r) => {
          const fda = (r.openfda ?? {}) as Record<string, unknown>;
          return {
            brandName: first(fda.brand_name),
            genericName: first(fda.generic_name),
            manufacturer: first(fda.manufacturer_name),
            indications: snippet(r.indications_and_usage),
            warnings: snippet(r.warnings),
          };
        });
        if (labels.length === 0) {
          return {
            text: `No FDA drug labels matching "${name}".`,
            structured: { query: name, count: 0, labels: [] },
          };
        }
        const lines = labels
          .map(
            (l) =>
              `  ${l.brandName ?? l.genericName ?? '?'}${l.manufacturer ? ` (${l.manufacturer})` : ''}${l.indications ? `\n    Indications: ${l.indications}` : ''}`,
          )
          .join('\n');
        return {
          text: `${labels.length} drug label(s) for "${name}":\n${lines}`,
          structured: { query: name, count: labels.length, labels },
        };
      },
    },
    {
      name: 'search_recalls',
      title: 'openFDA: Recalls',
      description:
        'Search FDA recall enforcement reports for food, drugs, or devices by ' +
        'keyword (firm, product, or reason — e.g. "listeria", "Tylenol"). Returns ' +
        'the recalling firm, product, reason, classification, status, and date.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        category: z.enum(['food', 'drug', 'device']).describe('Recall category.'),
        query: z.string().min(1).describe('Keyword, e.g. "listeria" or a brand name.'),
        limit: z.number().int().min(1).max(15).default(5).describe('Max recalls (1–15).'),
      }),
      output: z.object({
        category: z.string(),
        query: z.string(),
        count: z.number(),
        recalls: z.array(
          z.object({
            firm: z.string().nullable(),
            product: z.string().nullable(),
            reason: z.string().nullable(),
            classification: z.string().nullable(),
            status: z.string().nullable(),
            date: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { category, query, limit } = args;
        ctx.log('search_recalls', { category, query, limit });
        const search = fdaSearch(
          ['reason_for_recall', 'product_description', 'recalling_firm'],
          query,
        );
        const url = `${BASE_URL}/${category}/enforcement.json?search=${search}&limit=${limit}`;
        const results = await getResults(url, ctx);
        const recalls = results.map((r) => ({
          firm: typeof r.recalling_firm === 'string' ? r.recalling_firm : null,
          product:
            typeof r.product_description === 'string' ? r.product_description.slice(0, 160) : null,
          reason:
            typeof r.reason_for_recall === 'string' ? r.reason_for_recall.slice(0, 200) : null,
          classification: typeof r.classification === 'string' ? r.classification : null,
          status: typeof r.status === 'string' ? r.status : null,
          date: typeof r.recall_initiation_date === 'string' ? r.recall_initiation_date : null,
        }));
        if (recalls.length === 0) {
          return {
            text: `No ${category} recalls matching "${query}".`,
            structured: { category, query, count: 0, recalls: [] },
          };
        }
        const lines = recalls
          .map(
            (r) =>
              `  [${r.classification ?? '?'}] ${r.firm ?? '?'} (${r.date ?? '?'}): ${r.reason ?? '?'}`,
          )
          .join('\n');
        return {
          text: `${recalls.length} ${category} recall(s) for "${query}":\n${lines}`,
          structured: { category, query, count: recalls.length, recalls },
        };
      },
    },
  ],
});
