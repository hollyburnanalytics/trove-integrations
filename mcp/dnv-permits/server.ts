import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';

/**
 * DNV Building Permits — a no-auth hosted MCP server over the District of North
 * Vancouver's public permit-search JSON API (`app.dnv.org/dnv_search`).
 *
 * Reads the District's public permit-search JSON API directly (no HTML scraping).
 * Three read-only surfaces:
 *  - `/query/{q}`       — all permits at an address (or case-number prefix),
 *  - `/autosuggest/{q}` — address typeahead (≤15 matches), and
 *  - `/last/`           — the 20 most-recently-issued permits district-wide.
 *
 * The API is fully public (no key, token, or cookie). Permit data goes back to
 * ~1992. A 404 means "no permits" (returned as an empty list); a 429 is surfaced
 * as retryable.
 */

/** Base path for the DNV permit-search API. */
const BASE_URL = 'https://app.dnv.org/dnv_search/api/v1/permitsearch';

/** Honest, attributable User-Agent identifying this client to the public API. */
const USER_AGENT = 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)';

/** One permit as returned by the DNV permit-search API. */
interface RawPermit {
  caseNumber?: unknown;
  date?: unknown;
  status?: unknown;
  address?: unknown;
  workclass?: unknown;
  value?: unknown;
  contact?: unknown;
}

/** A permit projected onto the wire shape (value ≤ 0 normalized to null). */
interface Permit {
  /** Permit id, e.g. "BLD2020-00231" (prefixes: BLD, ELEC, PLBG, GAS, …). */
  caseNumber: string;
  /** Application/issued date (ISO), or null when absent. */
  date: string | null;
  /** Permit status, e.g. "Issued", "Closed", "Finaled". */
  status: string | null;
  /** Property address (as the District stores it, usually uppercased). */
  address: string | null;
  /** Work class, e.g. "New single family building", "Demolition permit". */
  workclass: string | null;
  /** Declared permit value in dollars; null when the District reports N/A (≤ 0). */
  value: number | null;
  /** Contractor name, or "Owner". */
  contact: string | null;
}

/** Coerce an unknown to a trimmed string, or null when empty/absent. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Project a raw permit onto the wire shape, normalizing the value sentinel. */
function toPermit(raw: RawPermit): Permit {
  const value = typeof raw.value === 'number' && raw.value > 0 ? raw.value : null;
  return {
    caseNumber: str(raw.caseNumber) ?? '',
    date: str(raw.date),
    status: str(raw.status),
    address: str(raw.address),
    workclass: str(raw.workclass),
    value,
    contact: str(raw.contact),
  };
}

/**
 * GET a DNV permit-search path and parse its JSON array. A 404 yields an empty
 * array (the API's "no match" signal); a 429 is a retryable rate-limit; any
 * other non-2xx is a retryable upstream error.
 *
 * Stays on raw `ctx.fetch` rather than `ctx.fetchJson`: a 404 must be returned
 * as an empty array (not raised), which `fetchJson` cannot express.
 *
 * @param path - Path under {@link BASE_URL} (already URL-encoded).
 * @param ctx - Tool context providing the sandboxed `fetch`.
 * @returns The parsed JSON array (caller narrows the element type).
 */
async function getJsonArray(path: string, ctx: Pick<ToolContext, 'fetch'>): Promise<unknown[]> {
  const res = await ctx.fetch(`${BASE_URL}${path}`, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  if (res.status === 404) return [];
  if (res.status === 429) {
    throw new ToolError('The DNV permit API is rate-limiting; try again shortly.', {
      retryable: true,
    });
  }
  if (!res.ok) {
    throw new ToolError('The DNV permit API is temporarily unavailable.', { retryable: true });
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new ToolError('The DNV permit API returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  return Array.isArray(parsed) ? parsed : [];
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_permits',
      title: 'DNV Permits: Search',
      description:
        'List every District of North Vancouver building permit at an address (or ' +
        'for a case-number prefix). Pass a street address like "2298 Hazellynn Pl" ' +
        '— use suggest_addresses first if you are unsure of the exact form. Returns ' +
        'permits with case number, date, status, work class, value, and contractor. ' +
        'An address with no permits returns an empty list.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .min(1)
          .describe('Street address or case-number prefix, e.g. "2298 Hazellynn Pl" or "BLD2020".'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        permits: z.array(
          z.object({
            caseNumber: z.string(),
            date: z.string().nullable(),
            status: z.string().nullable(),
            address: z.string().nullable(),
            workclass: z.string().nullable(),
            value: z.number().nullable(),
            contact: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query } = args;
        ctx.log('search_permits', { query });
        const raw = await getJsonArray(`/query/${encodeURIComponent(query)}`, ctx);
        const permits = raw.map((p) => toPermit(p as RawPermit));
        if (permits.length === 0) {
          return {
            text: `No DNV permits found for "${query}".`,
            structured: { query, count: 0, permits: [] },
          };
        }
        const lines = permits
          .map((p) => {
            const val = p.value !== null ? ` — $${p.value.toLocaleString()}` : '';
            const date = p.date ? p.date.slice(0, 10) : '?';
            return `  ${p.caseNumber} (${date}) ${p.status ?? '?'}: ${p.workclass ?? '?'}${val} [${p.contact ?? '?'}]`;
          })
          .join('\n');
        return {
          text: `${permits.length} DNV permit(s) for "${query}":\n${lines}`,
          structured: { query, count: permits.length, permits },
        };
      },
    },
    {
      name: 'suggest_addresses',
      title: 'DNV Permits: Address autocomplete',
      description:
        'Autocomplete real District of North Vancouver addresses from a partial ' +
        'string (up to 15 matches). Use to normalize an address before calling ' +
        'search_permits.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        prefix: z
          .string()
          .min(1)
          .describe('Partial address or street name, e.g. "hazel" or "2298 haz".'),
      }),
      output: z.object({
        prefix: z.string(),
        count: z.number(),
        addresses: z.array(z.string()),
      }),
      async handler(args, ctx) {
        const { prefix } = args;
        ctx.log('suggest_addresses', { prefix });
        const raw = await getJsonArray(`/autosuggest/${encodeURIComponent(prefix)}`, ctx);
        const addresses = raw
          .map((a) => (typeof a === 'string' ? a.trim() : ''))
          .filter((a) => a.length > 0);
        if (addresses.length === 0) {
          return {
            text: `No DNV addresses matching "${prefix}".`,
            structured: { prefix, count: 0, addresses: [] },
          };
        }
        return {
          text: `${addresses.length} address match(es) for "${prefix}":\n${addresses.map((a) => `  ${a}`).join('\n')}`,
          structured: { prefix, count: addresses.length, addresses },
        };
      },
    },
    {
      name: 'recent_permits',
      title: 'DNV Permits: Recent',
      description:
        'The 20 most-recently-issued District of North Vancouver building permits, ' +
        'district-wide. Use for "what permits were issued recently?".',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({}),
      output: z.object({
        count: z.number(),
        permits: z.array(
          z.object({
            caseNumber: z.string(),
            date: z.string().nullable(),
            status: z.string().nullable(),
            address: z.string().nullable(),
            workclass: z.string().nullable(),
            value: z.number().nullable(),
            contact: z.string().nullable(),
          }),
        ),
      }),
      async handler(_args, ctx) {
        ctx.log('recent_permits', {});
        const raw = await getJsonArray('/last/', ctx);
        const permits = raw.map((p) => toPermit(p as RawPermit));
        if (permits.length === 0) {
          return { text: 'No recent DNV permits returned.', structured: { count: 0, permits: [] } };
        }
        const lines = permits
          .map((p) => {
            const date = p.date ? p.date.slice(0, 10) : '?';
            return `  ${p.caseNumber} (${date}) ${p.address ?? '?'}: ${p.workclass ?? '?'}`;
          })
          .join('\n');
        return {
          text: `${permits.length} most-recent DNV permit(s):\n${lines}`,
          structured: { count: permits.length, permits },
        };
      },
    },
  ],
});
