import { tool, z } from '@ontrove/extend/toolkit';
import { describeWeather, FORECAST_URL, numAt, openMeteoError } from './api.ts';

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

/** The `forecast` tool. */
export const forecastTool = tool({
  name: 'forecast',
  title: 'Weather: Forecast',
  description:
    'Current conditions plus a multi-day daily forecast (high/low temp, ' +
    'precipitation, conditions) for a latitude/longitude. Use geocode_place ' +
    'first if you only have a place name. Units default to metric (°C, km/h, ' +
    'mm); pass units="imperial" for °F / mph / inch.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    days: z.number().int().min(1).max(16).default(5).describe('Forecast days (1–16).'),
    units: z.enum(['metric', 'imperial']).default('metric').describe('Unit system.'),
  }),
  output: z.object({
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string().nullable(),
    units: z.object({ temperature: z.string(), wind: z.string(), precipitation: z.string() }),
    current: z.object({
      temperature: z.number().nullable(),
      weather: z.string(),
      windSpeed: z.number().nullable(),
    }),
    daily: z.array(
      z.object({
        date: z.string(),
        temperatureMax: z.number().nullable(),
        temperatureMin: z.number().nullable(),
        precipitation: z.number().nullable(),
        weather: z.string(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { latitude, longitude, days, units } = args;
    const isImperial = units === 'imperial';
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: 'temperature_2m,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
      timezone: 'auto',
      forecast_days: String(days),
    });
    if (isImperial) {
      params.set('temperature_unit', 'fahrenheit');
      params.set('wind_speed_unit', 'mph');
      params.set('precipitation_unit', 'inch');
    }
    ctx.log('forecast', { latitude, longitude, days, units });
    const body = (await ctx.fetchJson(`${FORECAST_URL}?${params}`, {
      errorMap: openMeteoError,
    })) as Record<string, unknown>;

    const cur = (body.current ?? {}) as Record<string, unknown>;
    const daily = (body.daily ?? {}) as Record<string, unknown>;
    const times = Array.isArray(daily.time) ? daily.time : [];
    const rows = times.map((t, i) => ({
      date: typeof t === 'string' ? t : '',
      temperatureMax: numAt(daily.temperature_2m_max, i),
      temperatureMin: numAt(daily.temperature_2m_min, i),
      precipitation: numAt(daily.precipitation_sum, i),
      weather: describeWeather((daily.weather_code as unknown[] | undefined)?.[i]),
    }));
    const u = {
      temperature: isImperial ? '°F' : '°C',
      wind: isImperial ? 'mph' : 'km/h',
      precipitation: isImperial ? 'in' : 'mm',
    };
    const curTemp = typeof cur.temperature_2m === 'number' ? cur.temperature_2m : null;
    const curWind = typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : null;
    const lines = rows
      .map(
        (r) =>
          `  ${r.date}: ${r.weather}, ${r.temperatureMin ?? '?'}–${r.temperatureMax ?? '?'}${u.temperature}, precip ${r.precipitation ?? '?'}${u.precipitation}`,
      )
      .join('\n');
    return {
      text:
        `Now: ${describeWeather(cur.weather_code)}, ${curTemp ?? '?'}${u.temperature}, wind ${curWind ?? '?'} ${u.wind}.\n` +
        `${rows.length}-day forecast:\n${lines}`,
      structured: {
        latitude,
        longitude,
        timezone: typeof body.timezone === 'string' ? body.timezone : null,
        units: u,
        current: {
          temperature: curTemp,
          weather: describeWeather(cur.weather_code),
          windSpeed: curWind,
        },
        daily: rows,
      },
    };
  },
});
