import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { ARCHIVE_URL, MAX_HISTORY_DAYS, numAt, openMeteoError } from './api.ts';

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

/** The `historical` tool. */
export const historicalTool = tool({
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
        precipVals.length > 0 ? Math.round(precipVals.reduce((a, b) => a + b, 0) * 10) / 10 : null,
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
});
