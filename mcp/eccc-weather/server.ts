import { defineMcpServer } from '@ontrove/mcp';
import { airQuality } from './tools/air-quality.ts';
import { findLocation } from './tools/find-location.ts';
import { forecast } from './tools/forecast.ts';
import { wildfireSmoke } from './tools/wildfire-smoke.ts';

/**
 * Environment and Climate Change Canada — official Canadian weather, air
 * quality, and wildfire smoke from MSC GeoMet. No API key. Four read-only
 * surfaces, each in its own module under `tools/`:
 *
 *  - `find_location` — resolve a place name or coordinate to an ECCC forecast
 *    site id (ECCC publishes ~800 named sites, so most towns have their own
 *    point rather than an interpolated grid cell);
 *  - `forecast` — current conditions, 24 h of hourly detail, the multi-day
 *    period forecast, sunrise/sunset, and active warnings for one site;
 *  - `air_quality` — AQHI observations and hourly forecast for the zone nearest
 *    a coordinate;
 *  - `wildfire_smoke` — surface PM2.5 from wildfire plumes, from FireWork.
 *
 * Two hosts back these: `api.weather.gc.ca` (OGC API — Features, GeoJSON) for
 * the first three, and `geo.weather.gc.ca` (WMS, queried point-wise) for
 * FireWork's raster output. Shared constants and the bilingual-payload readers
 * live in `api.ts`.
 *
 * Coverage is Canada only. The ECCC Data Servers End-use Licence (v2.1) grants
 * commercial use and redistribution on condition the source is acknowledged, so
 * every response carries the required attribution string.
 */
export default defineMcpServer({
  tools: [findLocation, forecast, airQuality, wildfireSmoke],
});
