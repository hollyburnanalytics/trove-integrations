import { type ToolDefinition, z } from '@ontrove/mcp';
import {
  ATTRIBUTION,
  ecccError,
  featuresOf,
  numberOf,
  prop,
  SMOKE_LAYER,
  textOf,
  WMS_URL,
} from '../api.ts';

/**
 * `wildfire_smoke` — surface PM2.5 from wildfire plumes, from FireWork.
 *
 * FireWork (RAQDPS) is a raster model served over WMS rather than the OGC
 * Features API, so a point reading comes from `GetFeatureInfo`: a small
 * bounding box with the query pixel at its centre reads the model cell over the
 * coordinate. WMS 1.3.0 with `CRS=EPSG:4326` orders the bbox latitude-first,
 * which is why this does not reuse the lon-first `boxAround` helper.
 */

/** Half-width, in degrees, of the one-cell box handed to `GetFeatureInfo`. */
const PIXEL_BOX_DEG = 0.03;

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
    model: z.string(),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { latitude, longitude } = args as { latitude: number; longitude: number };
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetFeatureInfo',
      LAYERS: SMOKE_LAYER,
      QUERY_LAYERS: SMOKE_LAYER,
      CRS: 'EPSG:4326',
      BBOX: [
        latitude - PIXEL_BOX_DEG,
        longitude - PIXEL_BOX_DEG,
        latitude + PIXEL_BOX_DEG,
        longitude + PIXEL_BOX_DEG,
      ].join(','),
      WIDTH: '100',
      HEIGHT: '100',
      I: '50',
      J: '50',
      INFO_FORMAT: 'application/json',
    });
    ctx.log('wildfire_smoke', { latitude, longitude });
    const body = await ctx.fetchJson(`${WMS_URL}?${params}`, { errorMap: ecccError });

    const first = featuresOf(body)[0];
    const featureProperties = prop(first, 'properties');
    const pm25 = numberOf(prop(featureProperties, 'value'));
    const band = textOf(prop(featureProperties, 'class'));

    if (pm25 === null && band === null) {
      return {
        text:
          `No FireWork smoke data at ${latitude},${longitude} — the model covers ` +
          `Canada and is run during wildfire season.\n\n${ATTRIBUTION}`,
        structured: {
          latitude,
          longitude,
          pm25: null,
          band: null,
          model: MODEL,
          attribution: ATTRIBUTION,
        },
      };
    }
    return {
      text:
        `Wildfire smoke at ${latitude},${longitude}: ${pm25 ?? '?'} µg/m³ surface PM2.5` +
        `${band ? ` (${band})` : ''}, ${MODEL}.\n\n${ATTRIBUTION}`,
      structured: { latitude, longitude, pm25, band, model: MODEL, attribution: ATTRIBUTION },
    };
  },
};
