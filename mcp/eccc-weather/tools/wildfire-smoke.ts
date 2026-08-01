import { type ToolDefinition, z } from '@ontrove/mcp';
import { ATTRIBUTION, ecccError, parseWmsPoint, SMOKE_LAYER, wmsPointUrl } from '../api.ts';

/**
 * `wildfire_smoke` — surface PM2.5 from wildfire plumes, from FireWork.
 *
 * FireWork (RAQDPS) is a raster model served over WMS rather than the OGC
 * Features API, so a point reading comes from `GetFeatureInfo` — see
 * {@link wmsPointUrl} for the latitude-first bbox that WMS 1.3.0 requires under
 * `EPSG:4326`.
 *
 * The layer is not always instantiated (it is run for wildfire season), and
 * GeoMet reports that with an XML exception under a 200 status rather than an
 * error code, which {@link parseWmsPoint} maps to no-data.
 */

/** Human label for the model behind this reading. */
const MODEL = 'FireWork (RAQDPS) 10 km';

export const wildfireSmoke: ToolDefinition = {
  name: 'wildfire_smoke',
  title: 'ECCC: Wildfire smoke',
  description:
    'Surface PM2.5 attributable to wildfire and vegetation plumes at a ' +
    "coordinate, from Environment Canada's FireWork (RAQDPS) model at 10 km — " +
    'the operational Canadian smoke forecast. Returns micrograms per cubic ' +
    "metre plus the model's own concentration band. Canada only.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
  }),
  output: z.object({
    latitude: z.number(),
    longitude: z.number(),
    pm25: z.number().nullable(),
    band: z.string().nullable(),
    time: z.string().nullable(),
    model: z.string(),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { latitude, longitude } = args as { latitude: number; longitude: number };
    ctx.log('wildfire_smoke', { latitude, longitude });
    const response = await ctx.fetch(wmsPointUrl(SMOKE_LAYER, latitude, longitude));
    const body = await response.text();
    // `ctx.fetch` does not apply an errorMap, so status handling is explicit
    // here; a 200 carrying an XML exception is separately handled as no-data.
    if (!response.ok) throw ecccError(response, body);
    const point = parseWmsPoint(body);

    if (point === null) {
      return {
        text:
          `No FireWork smoke data at ${latitude},${longitude} — the model covers ` +
          `Canada and is run during wildfire season.\n\n${ATTRIBUTION}`,
        structured: {
          latitude,
          longitude,
          pm25: null,
          band: null,
          time: null,
          model: MODEL,
          attribution: ATTRIBUTION,
        },
      };
    }
    return {
      text:
        `Wildfire smoke at ${latitude},${longitude}: ${point.value ?? '?'} µg/m³ surface PM2.5` +
        `${point.band ? ` (${point.band})` : ''}, ${MODEL}.\n\n${ATTRIBUTION}`,
      structured: {
        latitude,
        longitude,
        pm25: point.value,
        band: point.band,
        time: point.time,
        model: MODEL,
        attribution: ATTRIBUTION,
      },
    };
  },
};
