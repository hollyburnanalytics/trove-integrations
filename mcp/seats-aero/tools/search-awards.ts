import { tool, z } from '@ontrove/mcp';
import { apiKey, quotaNote, seatsJson } from '../client.ts';
import {
  availabilityOutput,
  cabinEnum,
  includeFiltered,
  pageInput,
  pageOutput,
  quotaOutput,
} from '../fields.ts';
import { homeAirports, searchQuery } from '../params.ts';
import { PROGRAMS } from '../programs.ts';
import { renderPage, toPage } from '../render.ts';
import { WireAvailabilityPage } from '../wire.ts';

/**
 * `search_awards` — the cached search (`GET /search`), Seats.aero's own Search
 * feature: award space between named airports over a date window, across every
 * mileage program at once.
 *
 * One call answers a whole month over many origins and destinations, which is
 * the point on a 1,000-call-a-day budget. Nothing is auto-paged: the result says
 * whether more exists and exactly how to ask for it.
 */
export const searchAwards = tool({
  name: 'search_awards',
  title: 'Seats.aero: Search award availability',
  description:
    `Search cached award availability between airports over a date range, across all ${PROGRAMS.length} ` +
    'mileage programs at once. Returns one summary per route/date/program with the cabins ' +
    'that are actually available, their mileage price, seats left, direct/connecting, and ' +
    'operating airlines — plus the availability id that get_trips expands into flights. ' +
    'This is the cheap, fast surface: one call covers many airports and a whole month. Use ' +
    "live_search only when you need this second's inventory for one route on one program.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    origin_airport: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Origin IATA airport codes, e.g. ["SFO","OAK"]. Airports only — not cities. ' +
          'Omit to use the home airports set in this toolkit\u2019s settings; omitting it ' +
          'with none set is an error rather than a search of everywhere.',
      ),
    destination_airport: z
      .array(z.string())
      .min(1)
      .describe('Destination IATA airport codes, e.g. ["LHR","LGW"].'),
    start_date: z.string().optional().describe('Earliest departure date, YYYY-MM-DD.'),
    end_date: z.string().optional().describe('Latest departure date, YYYY-MM-DD.'),
    cabins: z
      .array(cabinEnum)
      .optional()
      .describe('Only results with these cabins available. Omit for every cabin.'),
    sources: z
      .array(z.string())
      .optional()
      .describe('Restrict to these mileage program slugs (see list_programs). Omit for all.'),
    carriers: z
      .array(z.string())
      .optional()
      .describe('Only results involving these 2-letter airline codes, e.g. ["DL","AA"].'),
    only_direct_flights: z
      .boolean()
      .default(false)
      .describe('Only results with a non-stop option, honouring the cabin filter.'),
    order_by: z
      .enum(['lowest_mileage'])
      .optional()
      .describe(
        'Cheapest first. The default ordering is by departure date, ranking results with premium cabins above those without.',
      ),
    include_trips: z
      .boolean()
      .default(false)
      .describe(
        'Embed flight-level trips in each result. Far larger and slower: 1000 results with trips is ~11 MB and ~8s, so take is clamped to 200 (500 with minify_trips) when this is on. Prefer calling get_trips on the ids you care about.',
      ),
    minify_trips: z
      .boolean()
      .default(false)
      .describe(
        'Shrink embedded trips to nine fields — cabin, miles, taxes, seats, stops, duration, carriers and ids. Drops the flight numbers, times and per-leg segments entirely, so use it for pricing sweeps, not for itineraries. Only applies when include_trips is on.',
      ),
    include_filtered: includeFiltered,
    ...pageInput,
  }),
  output: z.object({
    page: pageOutput,
    notes: z.array(z.string()),
    quota: quotaOutput,
    results: z.array(availabilityOutput),
  }),
  async handler(args, ctx) {
    // Read fresh on every call, so a preference changed in the dashboard
    // applies to the next question rather than the next session.
    const { params, notes } = searchQuery(args, new Date(), homeAirports(ctx));
    const key = await apiKey(ctx);
    ctx.log('search_awards', {
      origin: params.get('origin_airport'),
      destination: params.get('destination_airport'),
      sources: params.get('sources'),
    });

    const { body, quota } = await seatsJson(
      { path: `/search?${params}`, what: 'search cached award availability' },
      ctx,
      key,
      WireAvailabilityPage,
    );

    const { results, page } = toPage(body, args.skip);
    const route = `${params.get('origin_airport')} → ${params.get('destination_airport')}`;
    const window =
      args.start_date || args.end_date
        ? ` · ${args.start_date ?? 'any'} to ${args.end_date ?? 'any'}`
        : '';
    return {
      text: renderPage(`Award availability: ${route}${window}`, results, page, [
        ...notes,
        ...quotaNote(quota),
      ]),
      structured: { page, notes, quota, results },
    };
  },
});
