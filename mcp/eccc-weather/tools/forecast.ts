import { type ToolDefinition, ToolError, z } from '@ontrove/extend/toolkit';
import {
  ATTRIBUTION,
  arrayProp,
  CITYPAGE_COLLECTION,
  ecccError,
  en,
  numberOf,
  OGC_URL,
  pressureHpa,
  prop,
  textOf,
  toLocation,
  windChillAt,
  windSpeedOf,
} from '../api.ts';

/**
 * `forecast` — Environment Canada's official forecast for one City Page site.
 *
 * Periods carry **no** precipitation-probability field. The collection's
 * queryables advertise `forecastGroup.forecasts.abbreviated_forecast.pop`, but
 * no period in a live payload contains `pop` in any spelling —
 * `abbreviatedForecast` holds only `icon` and `textSummary`. The probability
 * appears in the prose alone ("40 percent chance of showers"), so no numeric
 * field is offered here. The hourly rows' `lop` is real and is exposed.
 *
 * Field sweep note: `iconCode` (decorative weather glyphs), `cloudPrecip` (a
 * restatement of `textSummary`), `currentConditions.station` (the reporting
 * station's own id/coords, not the forecast site's) and `identifier` (duplicates
 * the feature `id`) are read from the payload and deliberately not surfaced.
 * Everything else ECCC sends here is exposed.
 *
 * Three horizons arrive in one payload and are all surfaced: current
 * conditions, 24 hours of hourly detail, and the multi-day day/night period
 * forecast. Sunrise/sunset and any active warnings ride along. Every timestamp
 * ECCC publishes here is UTC, and is passed through unchanged rather than
 * converted — callers localize.
 */
export const forecast: ToolDefinition = {
  name: 'forecast',
  title: 'ECCC: Forecast',
  description:
    "Environment Canada's official forecast for one site: current conditions, " +
    'hourly detail for the next 24 hours (temperature, wind, precipitation ' +
    'probability), the multi-day day/night period forecast, sunrise and sunset, ' +
    'and any active weather warnings. Use find_location first to get a siteId. ' +
    'Times are UTC (ISO 8601). Metric units.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    siteId: z.string().min(1).describe('ECCC forecast site id from find_location, e.g. "bc-99".'),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24)
      .default(12)
      .describe('How many hourly rows to return (1–24).'),
  }),
  output: z.object({
    siteId: z.string(),
    name: z.string().nullable(),
    region: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    url: z.string().nullable(),
    lastUpdated: z.string().nullable(),
    sunrise: z.string().nullable(),
    sunset: z.string().nullable(),
    current: z.object({
      observedAt: z.string().nullable(),
      temperature: z.number().nullable(),
      condition: z.string().nullable(),
      windSpeed: z.number().nullable(),
      windDirection: z.string().nullable(),
      windChill: z.number().nullable(),
      relativeHumidity: z.number().nullable(),
      dewpoint: z.number().nullable(),
      pressure: z.number().nullable(),
    }),
    hourly: z.array(
      z.object({
        time: z.string().nullable(),
        condition: z.string().nullable(),
        temperature: z.number().nullable(),
        windSpeed: z.number().nullable(),
        windDirection: z.string().nullable(),
        precipProbability: z.number().nullable(),
      }),
    ),
    periods: z.array(
      z.object({
        name: z.string().nullable(),
        summary: z.string().nullable(),
        temperature: z.number().nullable(),
        temperatureClass: z.string().nullable(),
        windSpeed: z.number().nullable(),
        windGust: z.number().nullable(),
        windDirection: z.string().nullable(),
        relativeHumidity: z.number().nullable(),
        uvIndex: z.number().nullable(),
        uvCategory: z.string().nullable(),
      }),
    ),
    warnings: z.array(
      z.object({
        type: z.string().nullable(),
        description: z.string().nullable(),
        priority: z.string().nullable(),
        url: z.string().nullable(),
      }),
    ),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { siteId, hours } = args as { siteId: string; hours: number };
    ctx.log('forecast', { siteId, hours });
    const body = await ctx.fetchJson(
      `${OGC_URL}/collections/${CITYPAGE_COLLECTION}/items/${encodeURIComponent(siteId)}?f=json`,
      { errorMap: ecccError },
    );

    const properties = prop(body, 'properties');
    if (properties === undefined) {
      throw new ToolError(
        `No Environment Canada site "${siteId}". Use find_location to get a valid siteId.`,
        { retryable: false },
      );
    }
    const location = toLocation(body);
    const conditions = prop(properties, 'currentConditions');
    const riseSet = prop(properties, 'riseSet');

    const temperature = numberOf(prop(conditions, 'temperature'));
    const current = {
      // Distinct from `lastUpdated`, which is when the document was published.
      observedAt: textOf(prop(conditions, 'timestamp')),
      temperature,
      condition: textOf(en(prop(conditions, 'condition'))),
      windSpeed: windSpeedOf(prop(prop(conditions, 'wind'), 'speed')),
      windDirection: textOf(prop(prop(conditions, 'wind'), 'direction')),
      windChill: windChillAt(prop(conditions, 'windChill'), temperature),
      relativeHumidity: numberOf(prop(conditions, 'relativeHumidity')),
      dewpoint: numberOf(prop(conditions, 'dewpoint')),
      pressure: pressureHpa(prop(conditions, 'pressure')),
    };

    const hourly = arrayProp(prop(properties, 'hourlyForecastGroup'), 'hourlyForecasts')
      .slice(0, hours)
      .map((entry) => ({
        time: textOf(prop(entry, 'timestamp')),
        condition: textOf(en(prop(entry, 'condition'))),
        temperature: numberOf(prop(entry, 'temperature')),
        windSpeed: windSpeedOf(prop(prop(entry, 'wind'), 'speed')),
        windDirection:
          textOf(en(prop(prop(prop(entry, 'wind'), 'direction'), 'windDirFull'))) ??
          textOf(prop(prop(entry, 'wind'), 'direction')),
        precipProbability: numberOf(prop(entry, 'lop')),
      }));

    const periods = arrayProp(prop(properties, 'forecastGroup'), 'forecasts').map((entry) => {
      const temperatures = arrayProp(prop(entry, 'temperatures'), 'temperature');
      const first = temperatures[0];
      const windPeriods = arrayProp(prop(entry, 'winds'), 'periods');
      const wind = windPeriods[0];
      return {
        name: textOf(en(prop(prop(entry, 'period'), 'textForecastName'))),
        summary: textOf(en(prop(entry, 'textSummary'))),
        temperature: numberOf(first),
        temperatureClass: textOf(en(prop(first, 'class'))),
        windSpeed: windSpeedOf(prop(wind, 'speed')),
        windGust: numberOf(prop(wind, 'gust')),
        windDirection: textOf(en(prop(wind, 'direction'))),
        relativeHumidity: numberOf(prop(entry, 'relativeHumidity')),
        uvIndex: numberOf(prop(prop(entry, 'uv'), 'index')),
        uvCategory: textOf(en(prop(prop(entry, 'uv'), 'category'))),
      };
    });

    const warnings = arrayProp(properties, 'warnings').map((entry) => ({
      type: textOf(en(prop(entry, 'type'))),
      description: textOf(en(prop(entry, 'description'))),
      priority: textOf(en(prop(entry, 'priority'))),
      url: textOf(en(prop(entry, 'url'))),
    }));

    const structured = {
      ...location,
      url: textOf(en(prop(properties, 'url'))),
      lastUpdated: textOf(prop(properties, 'lastUpdated')),
      sunrise: textOf(en(prop(riseSet, 'sunrise'))),
      sunset: textOf(en(prop(riseSet, 'sunset'))),
      current,
      hourly,
      periods,
      warnings,
      attribution: ATTRIBUTION,
    };

    const hourLines = hourly
      .map(
        (h) =>
          `  ${h.time ?? '?'}: ${h.condition ?? '?'}, ${h.temperature ?? '?'}°C, ` +
          `wind ${h.windSpeed ?? '?'} km/h${h.windDirection ? ` ${h.windDirection}` : ''}, ` +
          `precip ${h.precipProbability ?? 0}%`,
      )
      .join('\n');
    const periodLines = periods.map((p) => `  ${p.name ?? '?'}: ${p.summary ?? '?'}`).join('\n');
    const warningLine =
      warnings.length === 0
        ? 'No active warnings.'
        : `Warnings: ${warnings.map((w) => w.description ?? w.type ?? '?').join('; ')}`;

    return {
      text:
        `${location.name ?? siteId}${location.region ? `, ${location.region}` : ''} — ` +
        // ECCC omits the condition text at some sites/hours; skip it rather
        // than rendering a bare placeholder.
        `now ${current.condition === null ? '' : `${current.condition}, `}` +
        `${current.temperature ?? '?'}°C, ` +
        `wind ${current.windSpeed ?? '?'} km/h${current.windDirection ? ` ${current.windDirection}` : ''}.\n` +
        `Sunrise ${structured.sunrise ?? '?'} / sunset ${structured.sunset ?? '?'} (UTC).\n` +
        `${warningLine}\n` +
        `Next ${hourly.length} hour(s):\n${hourLines}\n` +
        `Outlook:\n${periodLines}\n\n${ATTRIBUTION}`,
      structured,
    };
  },
};
