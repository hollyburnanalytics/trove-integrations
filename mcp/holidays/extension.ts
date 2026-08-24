import { defineToolkit, ToolError, tool, z } from '@ontrove/extend/toolkit';

/**
 * Public Holidays — a no-auth hosted MCP server over the Nager.Date API
 * (date.nager.at). Two read-only surfaces:
 *  - `public_holidays` — all public holidays for a country in a given year, and
 *  - `next_holidays` — the upcoming public holidays for a country.
 *
 * No API key. Countries are ISO-2 codes (e.g. "CA", "US", "GB").
 */

/** Base path for the Nager.Date v3 API. */
const BASE_URL = 'https://date.nager.at/api/v3';

/** One holiday projected onto the wire shape. */
interface Holiday {
  date: string;
  name: string;
  localName: string;
  global: boolean;
  types: string[];
}

/** A Nager.Date holiday array (lenient — every field defaulted/optional). */
const HolidaysResponse = z.array(
  z.object({
    date: z.string().default(''),
    name: z.string().default(''),
    localName: z.string().default(''),
    global: z.boolean().default(false),
    types: z.array(z.string()).default([]),
  }),
);

/**
 * Map a Nager.Date non-2xx response: a 404 means an unknown country code (a
 * non-retryable caller error); everything else is treated as transient.
 */
function holidaysError(res: Response): ToolError {
  if (res.status === 404) {
    return new ToolError('Unknown country code (use an ISO-2 code like "CA" or "US").', {
      retryable: false,
    });
  }
  return new ToolError('The holidays service is temporarily unavailable.', { retryable: true });
}

/**
 * Format a holiday list as text + the structured payload.
 *
 * Generic over the caller's own fields rather than taking
 * `Record<string, unknown>`: the two tools sharing this helper declare
 * different output schemas (only one carries `year`), and a widened record
 * satisfies neither. Preserving `T` lets each caller's result match the schema
 * it actually declared.
 */
function holidayResult<T extends Record<string, unknown>>(
  heading: string,
  holidays: Holiday[],
  structured: T,
): { text: string; structured: T & { count: number; holidays: Holiday[] } } {
  if (holidays.length === 0) {
    return {
      text: `No holidays found for ${heading}.`,
      structured: { ...structured, count: 0, holidays: [] },
    };
  }
  const lines = holidays
    .map((h) => {
      const english = h.name === h.localName ? '' : ` (${h.name})`;
      return `  ${h.date}: ${h.localName}${english}`;
    })
    .join('\n');
  return {
    text: `${holidays.length} holiday(s) for ${heading}:\n${lines}`,
    structured: { ...structured, count: holidays.length, holidays },
  };
}

export default defineToolkit({
  id: 'holidays',
  name: 'Public Holidays',
  description: 'Public holidays for 100+ countries via the free Nager.Date API. No key required.',
  icon: '📅',
  version: '1.0.0',
  secrets: [],
  egress: ['date.nager.at'],
  scopes: [],
  visibility: 'shared',
  tools: [
    tool({
      name: 'public_holidays',
      title: 'Holidays: By year',
      description:
        'List all public holidays for a country in a given year. Country is an ' +
        'ISO-2 code (e.g. "CA", "US", "GB"). Returns each date with its local and ' +
        'English name.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        year: z.number().int().min(1975).max(2100).describe('Calendar year, e.g. 2026.'),
        country: z.string().length(2).describe('ISO-2 country code, e.g. "CA".'),
      }),
      output: z.object({
        year: z.number(),
        country: z.string(),
        count: z.number(),
        holidays: z.array(
          z.object({
            date: z.string(),
            name: z.string(),
            localName: z.string(),
            global: z.boolean(),
            types: z.array(z.string()),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { year, country } = args;
        const code = country.toUpperCase();
        ctx.log('public_holidays', { year, country: code });
        const holidays = await ctx.fetchJson(`${BASE_URL}/PublicHolidays/${year}/${code}`, {
          schema: HolidaysResponse,
          errorMap: holidaysError,
        });
        return holidayResult(`${code} ${year}`, holidays, { year, country: code });
      },
    }),
    tool({
      name: 'next_holidays',
      title: 'Holidays: Upcoming',
      description:
        'List the upcoming public holidays for a country (next ~365 days). Country ' +
        'is an ISO-2 code (e.g. "CA", "US", "GB").',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        country: z.string().length(2).describe('ISO-2 country code, e.g. "CA".'),
      }),
      output: z.object({
        country: z.string(),
        count: z.number(),
        holidays: z.array(
          z.object({
            date: z.string(),
            name: z.string(),
            localName: z.string(),
            global: z.boolean(),
            types: z.array(z.string()),
          }),
        ),
      }),
      async handler(args, ctx) {
        const code = args.country.toUpperCase();
        ctx.log('next_holidays', { country: code });
        const holidays = await ctx.fetchJson(`${BASE_URL}/NextPublicHolidays/${code}`, {
          schema: HolidaysResponse,
          errorMap: holidaysError,
        });
        return holidayResult(`upcoming in ${code}`, holidays, { country: code });
      },
    }),
  ],
});
