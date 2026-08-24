import { tool, z } from '@ontrove/extend/toolkit';
import { GEOCODE_URL, openMeteoError } from './api.ts';

/**
 * Open-Meteo Weather — a no-auth hosted MCP server over the free Open-Meteo API.
 *
 * Four read-only surfaces, no API key required:
 *  - `geocode_place` — turn a place name into coordinates (so the other tools
 *    can be driven by "Vancouver" rather than raw lat/lon),
 *  - `forecast` — current conditions + a multi-day daily forecast,
 *  - `historical` — daily archive weather over a date range (data back to 1940),
 *  - `air_quality` — current US AQI + particulate levels.
 *
 * Each surface lives on its own Open-Meteo host (geocoding / forecast / archive
 * / air quality), all allow-listed in the manifest. Coordinates are decimal
 * degrees. The host URLs, WMO code table, and response helpers live in
 * `./api.ts`.
 */

/** The `geocode_place` tool. */
export const geocodePlaceTool = tool({
  name: 'geocode_place',
  title: 'Weather: Find place',
  description:
    'Look up coordinates for a place name (city, town, landmark) so you can ' +
    'feed lat/lon into forecast or air_quality. Returns ranked matches with ' +
    'country, region, timezone, and population.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    name: z.string().min(1).describe('Place name, e.g. "Vancouver" or "North Vancouver".'),
    count: z.number().int().min(1).max(10).default(5).describe('Max matches (1–10).'),
  }),
  output: z.object({
    query: z.string(),
    count: z.number(),
    places: z.array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country: z.string().nullable(),
        admin1: z.string().nullable(),
        timezone: z.string().nullable(),
        population: z.number().nullable(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { name, count } = args;
    const url = `${GEOCODE_URL}?${new URLSearchParams({ name, count: String(count) })}`;
    ctx.log('geocode_place', { name, count });
    const body = (await ctx.fetchJson(url, { errorMap: openMeteoError })) as Record<
      string,
      unknown
    >;
    const raw = Array.isArray(body.results) ? body.results : [];
    const places = raw.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        name: typeof o.name === 'string' ? o.name : '',
        latitude: typeof o.latitude === 'number' ? o.latitude : 0,
        longitude: typeof o.longitude === 'number' ? o.longitude : 0,
        country: typeof o.country === 'string' ? o.country : null,
        admin1: typeof o.admin1 === 'string' ? o.admin1 : null,
        timezone: typeof o.timezone === 'string' ? o.timezone : null,
        population: typeof o.population === 'number' ? o.population : null,
      };
    });
    if (places.length === 0) {
      return {
        text: `No places matching "${name}".`,
        structured: { query: name, count: 0, places: [] },
      };
    }
    const lines = places
      .map((p) => {
        const region = p.admin1 ? `, ${p.admin1}` : '';
        const country = p.country ? `, ${p.country}` : '';
        return `  ${p.name}${region}${country} → ${p.latitude},${p.longitude}`;
      })
      .join('\n');
    return {
      text: `${places.length} match(es) for "${name}":\n${lines}`,
      structured: { query: name, count: places.length, places },
    };
  },
});
