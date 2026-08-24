import { type ToolDefinition, z } from '@ontrove/extend/toolkit';
import {
  AQHI_FORECASTS_COLLECTION,
  AQHI_OBSERVATIONS_COLLECTION,
  AQHI_STATION_FIELDS,
  AQHI_STATIONS_COLLECTION,
  ATTRIBUTION,
  aqhiCategory,
  boxAround,
  ecccError,
  featuresOf,
  itemsUrl,
  nearestFeature,
  numberOf,
  prop,
  SEARCH_BOX_DEG,
  textOf,
} from '../api.ts';

/**
 * `air_quality` — the Air Quality Health Index for the zone nearest a point.
 *
 * AQHI is published per zone rather than per coordinate, so this resolves the
 * nearest zone first and reports how far away it landed — a caller can then
 * judge whether the reading is representative. Observations and forecasts are
 * fetched in parallel once the zone is known.
 */
export const airQuality: ToolDefinition = {
  name: 'air_quality',
  title: 'ECCC: Air quality (AQHI)',
  description:
    "Canada's Air Quality Health Index for the zone nearest a coordinate: the " +
    'latest hourly observation plus the hourly forecast. AQHI runs 1–10+ ' +
    '(1–3 low risk, 4–6 moderate, 7–10 high, above 10 very high) and is derived ' +
    'from PM2.5, NO2 and ozone. Canada only.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    hours: z
      .number()
      .int()
      .min(1)
      .max(48)
      .default(12)
      .describe('How many forecast hours to return (1–48).'),
  }),
  output: z.object({
    zoneId: z.string().nullable(),
    zoneName: z.string().nullable(),
    distanceKm: z.number().nullable(),
    observed: z.object({
      aqhi: z.number().nullable(),
      category: z.string(),
      time: z.string().nullable(),
    }),
    forecast: z.array(
      z.object({
        time: z.string().nullable(),
        aqhi: z.number().nullable(),
        category: z.string(),
      }),
    ),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { latitude, longitude, hours } = args as {
      latitude: number;
      longitude: number;
      hours: number;
    };
    ctx.log('air_quality', { latitude, longitude, hours });

    const stations = await ctx.fetchJson(
      itemsUrl(AQHI_STATIONS_COLLECTION, {
        bbox: boxAround(latitude, longitude, SEARCH_BOX_DEG),
        limit: '100',
        properties: AQHI_STATION_FIELDS,
      }),
      { errorMap: ecccError },
    );
    const nearest = nearestFeature(featuresOf(stations), latitude, longitude);
    if (nearest === null) {
      return {
        text:
          `No Environment Canada air quality zone near ${latitude},${longitude}. ` +
          'Coverage is Canada only.',
        structured: {
          zoneId: null,
          zoneName: null,
          distanceKm: null,
          observed: { aqhi: null, category: 'Unknown', time: null },
          forecast: [],
          attribution: ATTRIBUTION,
        },
      };
    }
    const zoneProperties = prop(nearest.feature, 'properties');
    const zoneId = textOf(prop(zoneProperties, 'location_id'));
    const zoneName = textOf(prop(zoneProperties, 'location_name_en'));
    const zoneQuery = zoneId ?? '';

    const [observations, forecasts] = await Promise.all([
      ctx.fetchJson(
        itemsUrl(AQHI_OBSERVATIONS_COLLECTION, {
          location_id: zoneQuery,
          latest: 'true',
          limit: '1',
        }),
        { errorMap: ecccError },
      ),
      ctx.fetchJson(
        itemsUrl(AQHI_FORECASTS_COLLECTION, {
          location_id: zoneQuery,
          // ECCC keeps several days of superseded runs in this collection, so
          // sorting by forecast time alone surfaces a stale run. Sort newest
          // publication first and keep only that run (filtered below).
          sortby: '-publication_datetime',
          // Wide enough to cover the elapsed head of the run as well as the
          // hours being asked for: rows arrive earliest-first within a run, so
          // fetching only `hours` would return the part already in the past.
          limit: String(Math.min(hours + 48, 120)),
        }),
        { errorMap: ecccError },
      ),
    ]);

    const latest = featuresOf(observations)[0];
    const latestProperties = prop(latest, 'properties');
    const observedAqhi = numberOf(prop(latestProperties, 'aqhi'));
    const observed = {
      aqhi: observedAqhi,
      category: aqhiCategory(observedAqhi),
      time: textOf(prop(latestProperties, 'observation_datetime')),
    };

    const rows = featuresOf(forecasts).map((feature) => {
      const featureProperties = prop(feature, 'properties');
      const value = numberOf(prop(featureProperties, 'aqhi'));
      return {
        publishedAt: textOf(prop(featureProperties, 'publication_datetime')) ?? '',
        time: textOf(prop(featureProperties, 'forecast_datetime')),
        aqhi: value,
        category: aqhiCategory(value),
      };
    });
    // Keep a single run — mixing publications would interleave hours from
    // different model cycles — then order it forward in time.
    let newestRun = '';
    for (const row of rows) {
      if (row.publishedAt > newestRun) newestRun = row.publishedAt;
    }
    // A run also covers hours that have already elapsed by the time it is
    // read — the 00Z publication still carries 00Z–03Z at 04Z — so a caller
    // asking for "the next N hours" would be handed the past. Drop elapsed
    // hours, but fall back to the whole run rather than returning nothing if
    // every row is behind (a stale publication is better than silence).
    const currentHour = new Date();
    currentHour.setUTCMinutes(0, 0, 0);
    const cutoff = currentHour.toISOString();
    const inRun = rows
      .filter((row) => row.publishedAt === newestRun)
      .toSorted((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    const upcoming = inRun.filter((row) => (row.time ?? '') >= cutoff);
    const forecast = (upcoming.length > 0 ? upcoming : inRun)
      .slice(0, hours)
      .map(({ publishedAt: _publishedAt, ...rest }) => rest);

    const away = Math.round(nearest.distanceKm * 10) / 10;
    const lines = forecast.map((f) => `  ${f.time ?? '?'}: AQHI ${f.aqhi ?? '?'} (${f.category})`);
    return {
      text:
        `${zoneName ?? zoneQuery} (${away} km away) — observed AQHI ` +
        `${observed.aqhi ?? '?'} (${observed.category}) at ${observed.time ?? '?'}.\n` +
        `Forecast (${forecast.length} h):\n${lines.join('\n')}\n\n${ATTRIBUTION}`,
      structured: {
        zoneId,
        zoneName,
        distanceKm: away,
        observed,
        forecast,
        attribution: ATTRIBUTION,
      },
    };
  },
};
