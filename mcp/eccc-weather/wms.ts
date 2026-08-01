import { featuresOf, numberOf, prop, textOf } from './api.ts';

/**
 * GeoMet's WMS half: the raster model layers, read one point at a time.
 *
 * Separated from `api.ts` (the OGC API — Features half) because the two speak
 * different dialects — GeoJSON collections with bilingual leaves on one side,
 * `GetFeatureInfo` over rasters with an axis-order trap on the other.
 */

/** MSC GeoMet WMS (raster model output, queried point-wise). */
export const WMS_URL = 'https://geo.weather.gc.ca/geomet';

/**
 * FireWork (RAQDPS) surface PM2.5 attributable to wildfire and vegetation
 * plumes — Canada's operational smoke model, 10 km.
 */
export const SMOKE_LAYER = 'RAQDPS.Sfc_PM2.5-WildfireSmokePlume';

/** One HRDPS surface field exposed by `model_point`. */
export interface HrdpsVariable {
  /** GeoMet WMS layer name. */
  layer: string;
  /** Unit of the value this server reports (after {@link HrdpsVariable.scale}). */
  unit: string;
  /**
   * Factor applied to the raw model value. HRDPS publishes wind in m/s while
   * City Page and SWOB use km/h, so wind is converted for consistency across
   * the toolkit rather than leaving callers to notice the mismatch.
   */
  scale?: number;
}

/**
 * The HRDPS surface fields `model_point` exposes, at 2.5 km. Deliberately a
 * curated subset — GeoMet serves ~38,000 layers, most of them upper-air or
 * derived fields with no use here.
 */
export const HRDPS_VARIABLES: Record<string, HrdpsVariable> = {
  cloudCover: { layer: 'HRDPS.CONTINENTAL_NT', unit: '%' },
  temperature: { layer: 'HRDPS.CONTINENTAL_TT', unit: '°C' },
  dewpoint: { layer: 'HRDPS.CONTINENTAL_TD', unit: '°C' },
  relativeHumidity: { layer: 'HRDPS.CONTINENTAL_HR', unit: '%' },
  windSpeed: { layer: 'HRDPS.CONTINENTAL_WSPD', unit: 'km/h', scale: 3.6 },
  windDirection: { layer: 'HRDPS.CONTINENTAL_WD', unit: '°' },
  windGust: { layer: 'HRDPS.CONTINENTAL_WGE', unit: 'km/h', scale: 3.6 },
  uvIndex: { layer: 'HRDPS.CONTINENTAL_IUVA', unit: 'index' },
};

/**
 * Hard ceiling on WMS point reads per `model_point` call. Every
 * (variable × hour) pair is one HTTP request, so an unbounded range would fan
 * out badly; the tool rejects a request above this rather than issuing it.
 */
export const MAX_POINT_QUERIES = 48;

/**
 * How many WMS reads to have in flight at once. Deliberately low: GeoMet
 * answers bursts with HTTP 429, which was observed while building this.
 */
export const WMS_CONCURRENCY = 3;

/** One value read out of a WMS raster layer at a point. */
export interface WmsPoint {
  value: number | null;
  /** The model's own class label for the value, e.g. `"< 1 [ug/m3]"`. */
  band: string | null;
  /** Valid time of the field. */
  time: string | null;
  /** Model run the field came from. */
  referenceTime: string | null;
}

/**
 * Build a `GetFeatureInfo` URL reading one layer at a point.
 *
 * WMS 1.3.0 under `CRS=EPSG:4326` orders the bbox **latitude-first** — the
 * reverse of the lon-first {@link boxAround} used against the Features API — so
 * the box is assembled here rather than shared.
 */
export function wmsPointUrl(layer: string, latitude: number, longitude: number, time?: string) {
  const half = 0.03;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo',
    LAYERS: layer,
    QUERY_LAYERS: layer,
    CRS: 'EPSG:4326',
    BBOX: [latitude - half, longitude - half, latitude + half, longitude + half].join(','),
    WIDTH: '100',
    HEIGHT: '100',
    I: '50',
    J: '50',
    INFO_FORMAT: 'application/json',
  });
  if (time !== undefined) params.set('TIME', time);
  return `${WMS_URL}?${params}`;
}

/**
 * Decode a `GetFeatureInfo` body, returning null when the layer has nothing at
 * this point/time.
 *
 * GeoMet answers an out-of-range `TIME` or an unavailable layer with **HTTP 200
 * carrying an XML `ServiceExceptionReport`**, not an error status — so parsing
 * the body as JSON unconditionally turns a routine "past the model horizon"
 * into a thrown exception. Anything that is not parseable JSON is treated as
 * no-data.
 */
export function parseWmsPoint(body: string): WmsPoint | null {
  if (body.trimStart().startsWith('<')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const first = featuresOf(parsed)[0];
  if (first === undefined) return null;
  const properties = prop(first, 'properties');
  const value = numberOf(prop(properties, 'value'));
  const band = textOf(prop(properties, 'class'));
  if (value === null && band === null) return null;
  return {
    value,
    band,
    time: textOf(prop(properties, 'time')),
    referenceTime: textOf(prop(properties, 'dim_reference_time')),
  };
}

/**
 * Map over `items` with at most `limit` calls in flight, preserving order.
 * Keeps a wide `model_point` request from opening dozens of sockets at once.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await run(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
