import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import {
  AIR_QUALITY_URL,
  ARCHIVE_URL,
  describeWeather,
  FORECAST_URL,
  GEOCODE_URL,
  MAX_HISTORY_DAYS,
  numAt,
  openMeteoError,
} from './api.ts';

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

export default defineMcpServer({
  tools: [
    {
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
          .map(
            (p) =>
              `  ${p.name}${p.admin1 ? `, ${p.admin1}` : ''}${p.country ? `, ${p.country}` : ''} → ${p.latitude},${p.longitude}`,
          )
          .join('\n');
        return {
          text: `${places.length} match(es) for "${name}":\n${lines}`,
          structured: { query: name, count: places.length, places },
        };
      },
    },
    {
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
        const imperial = units === 'imperial';
        const params = new URLSearchParams({
          latitude: String(latitude),
          longitude: String(longitude),
          current: 'temperature_2m,weather_code,wind_speed_10m',
          daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
          timezone: 'auto',
          forecast_days: String(days),
        });
        if (imperial) {
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
          temperature: imperial ? '°F' : '°C',
          wind: imperial ? 'mph' : 'km/h',
          precipitation: imperial ? 'in' : 'mm',
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
    },
    {
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
    },
    {
      name: 'historical',
      title: 'Weather: Historical',
      description:
        'Daily historical weather for a latitude/longitude over a date range, from ' +
        "Open-Meteo's reanalysis archive (data back to 1940). Returns each day's " +
        'high/low temperature and precipitation, plus a range summary (mean high, ' +
        'mean low, total precipitation). Use geocode_place first for a place name. ' +
        'Max 366 days per call — page by year for longer spans. Units default to ' +
        'metric (°C, mm); pass units="imperial" for °F / inch.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
        longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('Start date YYYY-MM-DD (1940-01-01 or later).'),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('End date YYYY-MM-DD (within 366 days of the start).'),
        units: z.enum(['metric', 'imperial']).default('metric').describe('Unit system.'),
      }),
      output: z.object({
        latitude: z.number(),
        longitude: z.number(),
        units: z.object({ temperature: z.string(), precipitation: z.string() }),
        summary: z.object({
          days: z.number(),
          meanTemperatureMax: z.number().nullable(),
          meanTemperatureMin: z.number().nullable(),
          totalPrecipitation: z.number().nullable(),
        }),
        daily: z.array(
          z.object({
            date: z.string(),
            temperatureMax: z.number().nullable(),
            temperatureMin: z.number().nullable(),
            precipitation: z.number().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { latitude, longitude, startDate, endDate, units } = args;
        const spanDays = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
        if (Number.isNaN(spanDays) || spanDays < 0) {
          throw new ToolError('endDate must be on or after startDate (YYYY-MM-DD).', {
            retryable: false,
          });
        }
        if (spanDays > MAX_HISTORY_DAYS) {
          throw new ToolError(
            `Range too long (${Math.round(spanDays)} days). Query at most ${MAX_HISTORY_DAYS} days per call and page by year.`,
            { retryable: false },
          );
        }
        const imperial = units === 'imperial';
        const params = new URLSearchParams({
          latitude: String(latitude),
          longitude: String(longitude),
          start_date: startDate,
          end_date: endDate,
          daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
          timezone: 'auto',
        });
        if (imperial) {
          params.set('temperature_unit', 'fahrenheit');
          params.set('precipitation_unit', 'inch');
        }
        ctx.log('historical', { latitude, longitude, startDate, endDate, units });
        const body = (await ctx.fetchJson(`${ARCHIVE_URL}?${params}`, {
          errorMap: openMeteoError,
        })) as Record<string, unknown>;

        const daily = (body.daily ?? {}) as Record<string, unknown>;
        const times = Array.isArray(daily.time) ? daily.time : [];
        const rows = times.map((t, i) => ({
          date: typeof t === 'string' ? t : '',
          temperatureMax: numAt(daily.temperature_2m_max, i),
          temperatureMin: numAt(daily.temperature_2m_min, i),
          precipitation: numAt(daily.precipitation_sum, i),
        }));
        const u = { temperature: imperial ? '°F' : '°C', precipitation: imperial ? 'in' : 'mm' };

        // Range summary over days that actually have data.
        const mean = (vals: Array<number | null>): number | null => {
          const nums = vals.filter((v): v is number => v !== null);
          return nums.length > 0
            ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
            : null;
        };
        const precipVals = rows.map((r) => r.precipitation).filter((v): v is number => v !== null);
        const summary = {
          days: rows.length,
          meanTemperatureMax: mean(rows.map((r) => r.temperatureMax)),
          meanTemperatureMin: mean(rows.map((r) => r.temperatureMin)),
          totalPrecipitation:
            precipVals.length > 0
              ? Math.round(precipVals.reduce((a, b) => a + b, 0) * 10) / 10
              : null,
        };
        if (rows.length === 0) {
          return {
            text: `No historical data for ${latitude},${longitude} (${startDate}–${endDate}).`,
            structured: { latitude, longitude, units: u, summary, daily: [] },
          };
        }
        return {
          text:
            `${startDate}–${endDate} at ${latitude},${longitude} (${summary.days} days): ` +
            `mean high ${summary.meanTemperatureMax ?? '?'}${u.temperature}, ` +
            `mean low ${summary.meanTemperatureMin ?? '?'}${u.temperature}, ` +
            `total precip ${summary.totalPrecipitation ?? '?'}${u.precipitation}.`,
          structured: { latitude, longitude, units: u, summary, daily: rows },
        };
      },
    },
  ],
});
