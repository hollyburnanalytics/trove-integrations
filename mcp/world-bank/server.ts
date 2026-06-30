import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * World Bank Data — a no-auth hosted MCP server over the World Bank Indicators
 * API (api.worldbank.org). Two read-only surfaces:
 *  - `search_indicators` — find an indicator code by keyword, and
 *  - `get_indicator` — fetch a country's time-series for an indicator code.
 *
 * No API key required. Country accepts ISO-2/ISO-3 codes or "all"; common
 * indicator codes: NY.GDP.MKTP.CD (GDP US$), SP.POP.TOTL (population),
 * FP.CPI.TOTL.ZG (inflation %), SL.UEM.TOTL.ZS (unemployment %).
 */

/** Base path for the World Bank v2 API. */
const BASE_URL = 'https://api.worldbank.org/v2';

/**
 * Extract the World Bank API's own error text from a `[{ message: [...] }]`
 * body (how it signals a bad query over HTTP 200), or null when absent. Lets a
 * rejected request surface *why* ("The provided parameter value is not valid")
 * instead of a blanket "check codes".
 */
function wbErrorMessage(parsed: unknown): string | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as Record<string, unknown> | null;
  const message = first && Array.isArray(first.message) ? first.message : null;
  const entry = message?.[0] as Record<string, unknown> | undefined;
  return entry && typeof entry.value === 'string' && entry.value ? entry.value : null;
}

/**
 * GET a World Bank endpoint. The API returns a 2-element array `[metadata,
 * rows]`; this returns that tuple. Kept on raw `ctx.fetch` (the SDK still
 * injects the default User-Agent) because the API signals a bad query with an
 * HTTP-200 `[ { message: [...] } ]` body — a shape error, not a status error —
 * which `fetchJson`'s status mapping can't express.
 *
 * Failures are surfaced with their real cause so transient outages can be told
 * apart from request bugs (the prior version masked every non-2xx, including a
 * 4xx bad-request, as a retryable "temporarily unavailable"):
 *  - a network error → retryable;
 *  - 429 / 5xx → retryable, with the HTTP status in the message;
 *  - any other 4xx → NON-retryable (the request was rejected, not the service);
 *  - an HTTP-200 error body → non-retryable, carrying the upstream message.
 */
async function getWb(
  url: string,
  ctx: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> },
): Promise<[Record<string, unknown>, unknown[]]> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new ToolError('The World Bank API is unreachable; try again shortly.', {
      retryable: true,
    });
  }
  if (!res.ok) {
    // 429 + 5xx are transient (service-side); other 4xx mean the request itself
    // was rejected (e.g. a bad country/indicator code) and a retry won't help.
    const transient = res.status === 429 || res.status >= 500;
    throw new ToolError(
      transient
        ? `The World Bank API is temporarily unavailable (HTTP ${res.status}).`
        : `The World Bank API rejected the request (HTTP ${res.status}); check the country and indicator codes.`,
      { retryable: transient },
    );
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 2) {
    const detail = wbErrorMessage(parsed);
    throw new ToolError(
      detail
        ? `The World Bank API rejected the request: ${detail}`
        : 'The World Bank API rejected the request (check the country and indicator codes).',
      { retryable: false },
    );
  }
  const meta = (parsed[0] ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(parsed[1]) ? parsed[1] : [];
  return [meta, rows];
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_indicators',
      title: 'World Bank: Find indicator',
      description:
        'Search World Development Indicators by keyword to find an indicator code ' +
        '(e.g. "GDP", "life expectancy", "CO2"). Returns code + name; pass the code ' +
        'to get_indicator. Searches the core WDI source.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Keyword(s), e.g. "life expectancy".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max matches (1–25).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        indicators: z.array(
          z.object({ id: z.string(), name: z.string(), note: z.string().nullable() }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('search_indicators', { query, limit });
        const [, rows] = await getWb(
          `${BASE_URL}/indicator?format=json&per_page=2000&source=2`,
          ctx,
        );
        const q = query.toLowerCase();
        const matches = rows
          .map((r) => r as Record<string, unknown>)
          .filter((r) => {
            const id = typeof r.id === 'string' ? r.id.toLowerCase() : '';
            const name = typeof r.name === 'string' ? r.name.toLowerCase() : '';
            return id.includes(q) || name.includes(q);
          })
          .slice(0, limit)
          .map((r) => ({
            id: typeof r.id === 'string' ? r.id : '',
            name: typeof r.name === 'string' ? r.name : '',
            note:
              typeof r.sourceNote === 'string' && r.sourceNote ? r.sourceNote.slice(0, 200) : null,
          }));
        if (matches.length === 0) {
          return {
            text: `No World Bank indicators matching "${query}".`,
            structured: { query, count: 0, indicators: [] },
          };
        }
        const lines = matches.map((m) => `  ${m.id} — ${m.name}`).join('\n');
        return {
          text: `${matches.length} indicator(s) for "${query}":\n${lines}`,
          structured: { query, count: matches.length, indicators: matches },
        };
      },
    },
    {
      name: 'get_indicator',
      title: 'World Bank: Get indicator',
      description:
        "Fetch a country's time-series for an indicator code. Country is ISO-2/ISO-3 " +
        '(e.g. "CA", "USA") or "all". Returns {year, value} points, newest first. ' +
        'Common codes: NY.GDP.MKTP.CD (GDP), SP.POP.TOTL (population), ' +
        'FP.CPI.TOTL.ZG (inflation %), SL.UEM.TOTL.ZS (unemployment %).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        country: z.string().min(2).describe('ISO-2/ISO-3 country code or "all", e.g. "CA".'),
        indicator: z.string().min(1).describe('Indicator code, e.g. "NY.GDP.MKTP.CD".'),
        start: z.number().int().optional().describe('Start year, e.g. 2010.'),
        end: z.number().int().optional().describe('End year, e.g. 2023.'),
      }),
      output: z.object({
        country: z.string(),
        indicator: z.string(),
        indicatorName: z.string().nullable(),
        count: z.number(),
        observations: z.array(z.object({ year: z.string(), value: z.number().nullable() })),
      }),
      async handler(args, ctx) {
        const { country, indicator, start, end } = args;
        ctx.log('get_indicator', { country, indicator, start, end });
        const params = new URLSearchParams({ format: 'json', per_page: '120' });
        if (start && end) params.set('date', `${start}:${end}`);
        const url = `${BASE_URL}/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}?${params}`;
        const [, rows] = await getWb(url, ctx);
        let indicatorName: string | null = null;
        const observations = rows.map((r) => {
          const o = r as Record<string, unknown>;
          const ind = (o.indicator ?? {}) as Record<string, unknown>;
          if (!indicatorName && typeof ind.value === 'string') indicatorName = ind.value;
          return {
            year: typeof o.date === 'string' ? o.date : '',
            value: typeof o.value === 'number' ? o.value : null,
          };
        });
        if (observations.length === 0) {
          return {
            text: `No World Bank data for ${indicator} / ${country}.`,
            structured: { country, indicator, indicatorName: null, count: 0, observations: [] },
          };
        }
        const withData = observations.filter((o) => o.value !== null).slice(0, 12);
        const lines = withData.map((o) => `  ${o.year}: ${o.value}`).join('\n');
        return {
          text: `${indicatorName ?? indicator} — ${country}:\n${lines}`,
          structured: {
            country,
            indicator,
            indicatorName,
            count: observations.length,
            observations,
          },
        };
      },
    },
  ],
});
