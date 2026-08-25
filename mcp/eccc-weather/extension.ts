import { defineToolkit } from '@ontrove/extend/toolkit';
import { airQuality } from './tools/air-quality.ts';
import { findLocation } from './tools/find-location.ts';
import { forecast } from './tools/forecast.ts';
import { modelPoint } from './tools/model-point.ts';
import { observations } from './tools/observations.ts';
import { wildfireSmoke } from './tools/wildfire-smoke.ts';

/**
 * Environment and Climate Change Canada — official Canadian weather, air
 * quality, and wildfire smoke from MSC GeoMet. No API key. Six read-only
 * surfaces, each in its own module under `tools/`:
 *
 *  - `find_location` — resolve a place name or coordinate to an ECCC forecast
 *    site id (ECCC publishes ~800 named sites, so most towns have their own
 *    point rather than an interpolated grid cell);
 *  - `forecast` — current conditions, 24 h of hourly detail, the multi-day
 *    period forecast, sunrise/sunset, and active warnings for one site;
 *  - `observations` — what the weather actually is, measured, at the nearest
 *    surface station;
 *  - `model_point` — hourly numeric HRDPS fields at a coordinate, including the
 *    total cloud cover City Page publishes only as condition text;
 *  - `air_quality` — AQHI observations and hourly forecast for the zone nearest
 *    a coordinate;
 *  - `wildfire_smoke` — surface PM2.5 from wildfire plumes, from FireWork.
 *
 * Two hosts back these: `api.weather.gc.ca` (OGC API — Features, GeoJSON) for
 * the site, station and AQHI collections, and `geo.weather.gc.ca` (WMS, queried
 * point-wise) for the raster model output behind `model_point` and
 * `wildfire_smoke`. Shared constants and the bilingual-payload readers live in
 * `api.ts`; the WMS dialect — layer names, `GetFeatureInfo`, the
 * bounded-concurrency runner — lives in `wms.ts`.
 *
 * Coverage is Canada only. The ECCC Data Servers End-use Licence (v2.1) grants
 * commercial use and redistribution on condition the source is acknowledged, so
 * every response carries the required attribution string.
 */
export default defineToolkit({
  id: 'eccc-weather',
  name: 'Environment Canada Weather',
  description:
    'Official Canadian weather from Environment and Climate Change Canada (MSC GeoMet): named-site forecasts with hourly detail, the Air Quality Health Index, and FireWork wildfire-smoke PM2.5. No key required. Licensed for commercial use under the ECCC Data Servers End-use Licence, with attribution.',
  icon: '🍁',
  version: '1.0.0',
  secrets: [],
  egress: ['api.weather.gc.ca', 'geo.weather.gc.ca'],
  scopes: [],
  visibility: 'shared',
  tools: [findLocation, forecast, observations, modelPoint, airQuality, wildfireSmoke],
});
