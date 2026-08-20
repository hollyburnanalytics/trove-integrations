import { tool, z } from '@ontrove/extend/toolkit';
import { AIR_QUALITY_URL, openMeteoError } from './api.ts';

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

/** The `air_quality` tool. */
export const airQualityTool = tool({
  name: 'air_quality',
  title: 'Weather: Air quality',
  description:
    'Current air quality at a latitude/longitude: US AQI plus PM2.5 and PM10 ' +
    'particulate levels (µg/m³). Use geocode_place first for a place name.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
  }),
  output: z.object({
    latitude: z.number(),
    longitude: z.number(),
    usAqi: z.number().nullable(),
    pm2_5: z.number().nullable(),
    pm10: z.number().nullable(),
  }),
  async handler(args, ctx) {
    const { latitude, longitude } = args;
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: 'us_aqi,pm2_5,pm10',
    });
    ctx.log('air_quality', { latitude, longitude });
    const body = (await ctx.fetchJson(`${AIR_QUALITY_URL}?${params}`, {
      errorMap: openMeteoError,
    })) as Record<string, unknown>;
    const cur = (body.current ?? {}) as Record<string, unknown>;
    const usAqi = typeof cur.us_aqi === 'number' ? cur.us_aqi : null;
    const pm25 = typeof cur.pm2_5 === 'number' ? cur.pm2_5 : null;
    const pm10 = typeof cur.pm10 === 'number' ? cur.pm10 : null;
    return {
      text: `Air quality at ${latitude},${longitude}: US AQI ${usAqi ?? '?'}, PM2.5 ${pm25 ?? '?'} µg/m³, PM10 ${pm10 ?? '?'} µg/m³.`,
      structured: { latitude, longitude, usAqi, pm2_5: pm25, pm10 },
    };
  },
});
