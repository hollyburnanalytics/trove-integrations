import { type ToolDefinition, z } from '@ontrove/mcp';
import {
  ATTRIBUTION,
  boxAround,
  coordsOf,
  ecccError,
  featuresOf,
  itemsUrl,
  nearestFeature,
  numberOf,
  prop,
  SEARCH_BOX_DEG,
  SWOB_OBSERVATIONS_COLLECTION,
  SWOB_STATION_FIELDS,
  SWOB_STATIONS_COLLECTION,
  SWOB_WIND_WINDOWS,
  textOf,
} from '../api.ts';

/**
 * `observations` — what the weather is actually doing, from the nearest SWOB
 * station.
 *
 * Everything else in this toolkit is a forecast; this is measurement. SWOB
 * records carry ~200 raw MSC-coded columns (`avg_wnd_spd_10m_pst10mts`,
 * `max_wnd_spd_10m_pst1hr`, …), so this projects a curated subset rather than
 * passing the payload through.
 *
 * Wind needs care: stations drop individual averaging windows between
 * observations, so the value is taken from the first window present in
 * {@link SWOB_WIND_WINDOWS} and the window actually used is reported alongside
 * it — a 1-minute mean and a 1-hour mean are not the same measurement, and a
 * caller comparing them without knowing which is which would be misled.
 */

/** Read a SWOB numeric column, tolerating the absent/null columns stations emit. */
function field(properties: unknown, key: string): number | null {
  return numberOf(prop(properties, key));
}

/** A wind reading plus the averaging window it actually came from. */
interface ResolvedWind {
  windSpeed: number | null;
  windDirection: number | null;
  windAveragingWindow: string | null;
}

/**
 * Take wind from the first averaging window this record actually reports,
 * preferring the WMO-standard 10-minute mean, and say which one that was.
 */
function resolveWind(properties: unknown): ResolvedWind {
  for (const window of SWOB_WIND_WINDOWS) {
    const speed = field(properties, `avg_wnd_spd_10m_${window.suffix}`);
    if (speed === null) continue;
    return {
      windSpeed: speed,
      windDirection: field(properties, `avg_wnd_dir_10m_${window.suffix}`),
      windAveragingWindow: window.label,
    };
  }
  return { windSpeed: null, windDirection: null, windAveragingWindow: null };
}

/** Render the wind clause, naming the averaging window so it cannot mislead. */
function describeWind({ windSpeed, windDirection, windAveragingWindow }: ResolvedWind): string {
  if (windSpeed === null) return 'wind not reported';
  const from = windDirection === null ? '' : ` from ${windDirection}°`;
  const window = windAveragingWindow === null ? '' : ` (${windAveragingWindow})`;
  return `wind ${windSpeed} km/h${from}${window}`;
}

export const observations: ToolDefinition = {
  name: 'observations',
  title: 'ECCC: Current observations',
  description:
    'Actual measured weather at the Environment Canada surface station nearest a ' +
    'coordinate — temperature, humidity, dew point, wind (with the averaging ' +
    'window used), peak gust in the past hour, pressure and precipitation. This ' +
    'is observation, not forecast; use it to check what conditions really are. ' +
    'Canada only. Times are UTC, units metric.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
  }),
  output: z.object({
    stationName: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    distanceKm: z.number().nullable(),
    observedAt: z.string().nullable(),
    airTemperature: z.number().nullable(),
    dewpoint: z.number().nullable(),
    relativeHumidity: z.number().nullable(),
    windSpeed: z.number().nullable(),
    windDirection: z.number().nullable(),
    windAveragingWindow: z.string().nullable(),
    windGustMaxPastHour: z.number().nullable(),
    pressure: z.number().nullable(),
    precipitationPastHour: z.number().nullable(),
    units: z.object({
      temperature: z.string(),
      wind: z.string(),
      pressure: z.string(),
      precipitation: z.string(),
    }),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { latitude, longitude } = args as { latitude: number; longitude: number };
    ctx.log('observations', { latitude, longitude });

    const stations = await ctx.fetchJson(
      itemsUrl(SWOB_STATIONS_COLLECTION, {
        bbox: boxAround(latitude, longitude, SEARCH_BOX_DEG),
        limit: '200',
        properties: SWOB_STATION_FIELDS,
      }),
      { errorMap: ecccError },
    );
    const nearest = nearestFeature(featuresOf(stations), latitude, longitude);
    const units = {
      temperature: '°C',
      wind: 'km/h',
      pressure: 'hPa',
      precipitation: 'mm',
    };
    const empty = {
      stationName: null,
      latitude: null,
      longitude: null,
      distanceKm: null,
      observedAt: null,
      airTemperature: null,
      dewpoint: null,
      relativeHumidity: null,
      windSpeed: null,
      windDirection: null,
      windAveragingWindow: null,
      windGustMaxPastHour: null,
      pressure: null,
      precipitationPastHour: null,
      units,
      attribution: ATTRIBUTION,
    };
    if (nearest === null) {
      return {
        text: `No Environment Canada surface station near ${latitude},${longitude}. Coverage is Canada only.`,
        structured: empty,
      };
    }
    const point = coordsOf(nearest.feature);
    if (point === null) {
      return {
        text: `No usable Environment Canada surface station near ${latitude},${longitude}.`,
        structured: empty,
      };
    }

    // The observations collection has no station-id filter, so the station is
    // re-found by a tight box around its own coordinates.
    const observed = await ctx.fetchJson(
      itemsUrl(SWOB_OBSERVATIONS_COLLECTION, {
        bbox: boxAround(point.latitude, point.longitude, 0.01),
        sortby: '-date_tm-value',
        limit: '1',
      }),
      { errorMap: ecccError },
    );
    const latest = featuresOf(observed)[0];
    const properties = prop(latest, 'properties');
    const stationName =
      textOf(prop(properties, 'stn_nam-value')) ??
      textOf(prop(prop(nearest.feature, 'properties'), 'name'));

    const wind = resolveWind(properties);

    const away = Math.round(nearest.distanceKm * 10) / 10;
    const structured = {
      stationName,
      latitude: point.latitude,
      longitude: point.longitude,
      distanceKm: away,
      observedAt: textOf(prop(properties, 'obs_date_tm')),
      airTemperature: field(properties, 'air_temp'),
      dewpoint: field(properties, 'dwpt_temp'),
      relativeHumidity: field(properties, 'rel_hum'),
      ...wind,
      windGustMaxPastHour: field(properties, 'max_wnd_spd_10m_pst1hr'),
      pressure: field(properties, 'stn_pres'),
      precipitationPastHour: field(properties, 'pcpn_amt_pst1hr'),
      units,
      attribution: ATTRIBUTION,
    };

    if (structured.observedAt === null) {
      return {
        text:
          `${stationName ?? 'Nearest station'} is ${away} km away but reported no ` +
          `recent observation.\n\n${ATTRIBUTION}`,
        structured,
      };
    }
    const windText = describeWind(wind);
    const gustText =
      structured.windGustMaxPastHour === null
        ? ''
        : `, peak gust ${structured.windGustMaxPastHour} km/h in the past hour`;
    return {
      text:
        `${stationName ?? 'Station'} (${away} km away), observed ${structured.observedAt}: ` +
        `${structured.airTemperature ?? '?'}°C, ` +
        `humidity ${structured.relativeHumidity ?? '?'}%, ${windText}${gustText}. ` +
        `Precipitation past hour ${structured.precipitationPastHour ?? '?'} mm.\n\n${ATTRIBUTION}`,
      structured,
    };
  },
};
