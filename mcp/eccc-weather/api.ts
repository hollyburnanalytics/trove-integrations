import { ToolError } from '@ontrove/mcp';

/**
 * Environment and Climate Change Canada (ECCC) API constants + response helpers.
 *
 * Two hosts back this server. `api.weather.gc.ca` is MSC GeoMet's OGC API —
 * Features endpoint, which serves city forecasts and AQHI as GeoJSON;
 * `geo.weather.gc.ca` is the WMS endpoint, whose raster layers are read one
 * point at a time via `GetFeatureInfo`.
 *
 * ECCC wraps almost every leaf in a bilingual `{ en, fr }` object, and numbers
 * are often nested a second time under `value`. {@link en}, {@link numberOf} and
 * {@link textOf} unwrap those shapes so handlers stay readable.
 */

/** MSC GeoMet OGC API — Features (GeoJSON collections). */
export const OGC_URL = 'https://api.weather.gc.ca';

/** MSC GeoMet WMS (raster model output, queried point-wise). */
export const WMS_URL = 'https://geo.weather.gc.ca/geomet';

/** City Page Weather — ~800 named Canadian forecast sites. */
export const CITYPAGE_COLLECTION = 'citypageweather-realtime';

/** Air Quality Health Index — zones, hourly observations, hourly forecasts. */
export const AQHI_STATIONS_COLLECTION = 'aqhi-stations';
export const AQHI_OBSERVATIONS_COLLECTION = 'aqhi-observations-realtime';
export const AQHI_FORECASTS_COLLECTION = 'aqhi-forecasts-realtime';

/** Surface Weather OBservations — real measured conditions, not forecasts. */
export const SWOB_STATIONS_COLLECTION = 'swob-stations';
export const SWOB_OBSERVATIONS_COLLECTION = 'swob-realtime';

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

/**
 * SWOB wind averaging windows, most-preferred first. WMO treats the 10-minute
 * mean as the surface wind, but stations drop individual windows between
 * observations (a reading can carry `pst1mt` and `pst2mts` while `pst10mts` is
 * null), so readers fall back down this list and report which window they used.
 */
export const SWOB_WIND_WINDOWS: { suffix: string; label: string }[] = [
  { suffix: 'pst10mts', label: '10-minute average' },
  { suffix: 'pst2mts', label: '2-minute average' },
  { suffix: 'pst1mt', label: '1-minute average' },
  { suffix: 'pst1hr', label: '1-hour average' },
];

/**
 * Attribution required by the ECCC Data Servers End-use Licence (v2.1), which
 * grants commercial use and redistribution on condition that the source is
 * acknowledged. Echoed in every tool response.
 */
export const ATTRIBUTION = 'Data Source: Environment and Climate Change Canada';

/**
 * Half-width, in degrees, of the bounding box used to find the site or air
 * quality zone nearest a coordinate. ~1.5° covers a wide enough area that rural
 * coordinates still resolve, while keeping the candidate list small.
 */
export const SEARCH_BOX_DEG = 1.5;

/** Mean Earth radius (km), for {@link distanceKm}. */
const EARTH_RADIUS_KM = 6371;

/**
 * Unwrap ECCC's bilingual `{ en, fr }` wrapper, preferring English. Values that
 * are not wrapped are returned unchanged.
 */
export function en(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'en' in value) {
    return (value as { en: unknown }).en;
  }
  return value;
}

/**
 * Read a possibly-`{ value: { en } }`-nested leaf as a finite number, or null.
 * Numeric strings are accepted; non-numeric text (ECCC reports a calm wind as
 * the literal `"calm"`) yields null — see {@link textOf} for that case.
 */
export function numberOf(value: unknown): number | null {
  const unwrapped =
    value !== null && typeof value === 'object' && 'value' in value
      ? (value as { value: unknown }).value
      : value;
  const raw = en(unwrapped);
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Read a possibly-`{ value: { en } }`-nested leaf as a non-empty string, or null. */
export function textOf(value: unknown): string | null {
  const unwrapped =
    value !== null && typeof value === 'object' && 'value' in value
      ? (value as { value: unknown }).value
      : value;
  const raw = en(unwrapped);
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (typeof raw === 'number') return String(raw);
  return null;
}

/** Read a plain object property, or undefined when the shape does not match. */
export function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Read a property as an array, or an empty array when absent/malformed. */
export function arrayProp(value: unknown, key: string): unknown[] {
  const found = prop(value, key);
  return Array.isArray(found) ? found : [];
}

/**
 * Wind speed as a number, mapping ECCC's literal `"calm"` onto 0 km/h. Callers
 * scoring "is it still?" need calm to compare numerically, not read as missing.
 */
export function windSpeedOf(value: unknown): number | null {
  const text = textOf(value);
  if (text !== null && /^calm$/i.test(text)) return 0;
  return numberOf(value);
}

/**
 * AQHI risk band, per ECCC's published scale: 1–3 low, 4–6 moderate, 7–10 high,
 * above 10 very high.
 */
export function aqhiCategory(aqhi: number | null): string {
  if (aqhi === null) return 'Unknown';
  if (aqhi <= 3) return 'Low risk';
  if (aqhi <= 6) return 'Moderate risk';
  if (aqhi <= 10) return 'High risk';
  return 'Very high risk';
}

/** Great-circle distance between two coordinates, in kilometres. */
export function distanceKm(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latitude1)) *
      Math.cos(toRadians(latitude2)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Read a GeoJSON feature's point coordinates as `[longitude, latitude]`. */
export function coordsOf(feature: unknown): { latitude: number; longitude: number } | null {
  const coordinates = prop(prop(feature, 'geometry'), 'coordinates');
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
  return { latitude, longitude };
}

/** A bounding box `minLon,minLat,maxLon,maxLat` centred on a coordinate. */
export function boxAround(latitude: number, longitude: number, halfWidth: number): string {
  return [
    longitude - halfWidth,
    latitude - halfWidth,
    longitude + halfWidth,
    latitude + halfWidth,
  ].join(',');
}

/** Read a GeoJSON `features` array off a collection response. */
export function featuresOf(body: unknown): unknown[] {
  return arrayProp(body, 'features');
}

/**
 * Pick the feature closest to a coordinate, ignoring any without usable
 * geometry. Returns the feature and its distance so callers can report how far
 * away the nearest station actually is.
 */
export function nearestFeature(
  features: unknown[],
  latitude: number,
  longitude: number,
): { feature: unknown; distanceKm: number } | null {
  let best: { feature: unknown; distanceKm: number } | null = null;
  for (const feature of features) {
    const point = coordsOf(feature);
    if (point === null) continue;
    const away = distanceKm(latitude, longitude, point.latitude, point.longitude);
    if (best === null || away < best.distanceKm) best = { feature, distanceKm: away };
  }
  return best;
}

/** Build an OGC API — Features `items` URL for one collection. */
export function itemsUrl(collection: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ f: 'json', ...params });
  return `${OGC_URL}/collections/${collection}/items?${query}`;
}

/** One City Page forecast site, as returned by `find_location` and `forecast`. */
export interface EcccLocation {
  siteId: string;
  name: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Summarize one City Page site feature as a location record. */
export function toLocation(feature: unknown): EcccLocation {
  const properties = prop(feature, 'properties');
  const point = coordsOf(feature);
  return {
    siteId: textOf(prop(feature, 'id')) ?? '',
    name: textOf(en(prop(properties, 'name'))),
    region: textOf(en(prop(properties, 'region'))),
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
  };
}

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

/**
 * Map an ECCC non-2xx response onto a {@link ToolError}, surfacing the service's
 * own `description` on a client error (non-retryable) and treating anything else
 * as transient.
 */
export function ecccError(res: Response, body: string): ToolError {
  if (res.status >= 400 && res.status < 500) {
    let detail = '';
    try {
      const parsed = JSON.parse(body) as { description?: unknown };
      if (typeof parsed.description === 'string') detail = parsed.description;
    } catch {
      detail = body.slice(0, 120);
    }
    return new ToolError(
      `Environment Canada rejected the request: ${detail || `HTTP ${res.status}`}.`,
      { retryable: false },
    );
  }
  return new ToolError('Environment Canada is temporarily unavailable.', { retryable: true });
}
