import { tool, z } from '@ontrove/extend/toolkit';
import { apiKey, quotaNote, seatsJson } from '../client.ts';
import {
  availabilityOutput,
  cabinEnum,
  includeFiltered,
  pageInput,
  pageOutput,
  quotaOutput,
  regionEnum,
} from '../fields.ts';
import { exploreQuery } from '../params.ts';
import { renderPage, toPage } from '../render.ts';
import { WireAvailabilityPage } from '../wire.ts';

/**
 * `explore_availability` — bulk availability (`GET /availability`), Seats.aero's
 * Explore feature: everything one mileage program has, filtered by region and
 * date rather than by named airports.
 *
 * The complement to `search_awards`, and the right tool for open-ended questions
 * ("where can Aeroplan get me in Europe in business next spring?") where naming
 * every destination airport up front is the wrong shape.
 */
export const exploreAvailability = tool({
  name: 'explore_availability',
  title: 'Seats.aero: Explore one program',
  description:
    'Browse everything one mileage program has, filtered by continent and date rather than ' +
    "by named airports — Seats.aero's Explore view. Use this for open-ended questions " +
    '("where can Aeroplan get me in Europe in business class in March?"); use search_awards ' +
    'when you already know the airports. Returns the same availability summaries, paged.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    source: z
      .string()
      .describe('The mileage program slug, e.g. aeroplan. Exactly one — see list_programs.'),
    cabin: cabinEnum.optional().describe('Only results with this cabin available.'),
    start_date: z.string().optional().describe('Earliest departure date, YYYY-MM-DD.'),
    end_date: z.string().optional().describe('Latest departure date, YYYY-MM-DD.'),
    origin_region: regionEnum.optional().describe('Only departures from this region.'),
    destination_region: regionEnum.optional().describe('Only arrivals into this region.'),
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
    const { params, notes } = exploreQuery(args, new Date());
    const key = await apiKey(ctx);
    ctx.log('explore_availability', { source: params.get('source'), cabin: params.get('cabin') });

    const { body, quota } = await seatsJson(
      { path: `/availability?${params}`, what: 'browse bulk award availability' },
      ctx,
      key,
      WireAvailabilityPage,
    );

    const { results, page } = toPage(body, args.skip);
    const scope = [
      args.origin_region ? `from ${args.origin_region}` : undefined,
      args.destination_region ? `to ${args.destination_region}` : undefined,
      args.cabin,
      args.start_date || args.end_date
        ? `${args.start_date ?? 'any'} to ${args.end_date ?? 'any'}`
        : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      text: renderPage(
        `${params.get('source')} availability${scope ? ` — ${scope}` : ''}`,
        results,
        page,
        [...notes, ...quotaNote(quota)],
      ),
      structured: { page, notes, quota, results },
    };
  },
});
