import { ToolError } from '@ontrove/extend/toolkit';

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

/** City Page Weather — 844 named Canadian forecast sites (measured 2026-08). */
export const CITYPAGE_COLLECTION = 'citypageweather-realtime';

/** Air Quality Health Index — zones, hourly observations, hourly forecasts. */
export const AQHI_STATIONS_COLLECTION = 'aqhi-stations';
export const AQHI_OBSERVATIONS_COLLECTION = 'aqhi-observations-realtime';
export const AQHI_FORECASTS_COLLECTION = 'aqhi-forecasts-realtime';

/** Surface Weather OBservations — real measured conditions, not forecasts. */
export const SWOB_STATIONS_COLLECTION = 'swob-stations';
export const SWOB_OBSERVATIONS_COLLECTION = 'swob-realtime';

/**
 * Property selectors for the station/site lookups.
 *
 * These collections embed a full forecast per feature, so an unfiltered
 * `find_location` box query downloads ~879 KB to read four fields. The OGC
 * `properties` selector takes the collection's dotted queryable paths (plain
 * `name` is rejected as "unknown properties specified"; `name.en` is accepted)
 * and cuts the same query to ~6 KB. Geometry and `id` are returned regardless.
 */
export const CITYPAGE_FIELDS = 'name.en,region.en';
export const SWOB_STATION_FIELDS = 'name';
export const AQHI_STATION_FIELDS = 'location_id,location_name_en';

/**
 * How many candidates a name search pulls before re-ranking. Re-ranking can
 * only reorder what was fetched, so requesting exactly `count` rows made the
 * ranking cosmetic — a better match sitting at position 6 could never reach a
 * 4-row answer. Cheap now that the field selector applies (~4 KB for 50).
 */
export const NAME_CANDIDATE_POOL = 50;

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
 * Read a City Page pressure leaf as hPa.
 *
 * City Page publishes station pressure in **kPa** (`units: "kPa"`, e.g. 101.5)
 * while SWOB publishes it in **hPa** (e.g. 1011.9). Reporting both unlabelled
 * would put the toolkit's two pressure readings a factor of ten apart, so the
 * declared unit is honoured and kPa is converted.
 */
export function pressureHpa(value: unknown): number | null {
  const raw = numberOf(value);
  if (raw === null) return null;
  const unit = textOf(prop(value, 'units'))?.toLowerCase();
  const hpa = unit === 'kpa' ? raw * 10 : raw;
  return Math.round(hpa * 10) / 10;
}

/**
 * Wind chill, but only where it is defined.
 *
 * ECCC leaves a stale `windChill` in `currentConditions` outside the cold
 * season — bc-99 reported `-2` while the temperature was 20.7 °C, with
 * `qaValue: 100`. Wind chill is only meaningful at or below freezing, so it is
 * suppressed above that rather than published as a fact.
 */
export function windChillAt(windChill: unknown, temperature: number | null): number | null {
  const value = numberOf(windChill);
  if (value === null || temperature === null || temperature > 0) return null;
  return value;
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
 * Total records matching a query, from the OGC `numberMatched` field — which is
 * a genuine total, not the page size (verified: `q=Vancouver&limit=5` reports
 * `numberMatched: 17`, `numberReturned: 5`). Null when the service omits it.
 */
export function matchedCount(body: unknown): number | null {
  return numberOf(prop(body, 'numberMatched'));
}

/**
 * Rank a City Page site against a name query, lower is better.
 *
 * The collection's `q=` is full-text across the region string as well as the
 * name, so "West Vancouver" matches Tofino, Ucluelet and Estevan Point — all on
 * *Vancouver Island*, whose region reads "West Vancouver Island". Those are
 * real matches for the search engine and useless as answers to "where is West
 * Vancouver", so name matches are pulled ahead of region-only ones rather than
 * dropped (the API's own ordering is kept as the tiebreak).
 */
export function nameRelevance(name: string | null, query: string): number {
  const candidate = (name ?? '').trim().toLowerCase();
  const wanted = query.trim().toLowerCase();
  if (candidate === '' || wanted === '') return 4;
  if (candidate === wanted) return 0;
  if (candidate.startsWith(wanted)) return 1;
  if (candidate.includes(wanted)) return 2;
  // Whole-string containment alone is not enough: against "West Vancouver",
  // both "Vancouver" and "Ucluelet" fail every test above, yet one is a far
  // better answer. Falling back to the share of query words present in the name
  // separates them (1/2 vs 0/2) and leaves region-only hits last.
  const words = wanted.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 4;
  const hits = words.filter((word) => candidate.includes(word)).length;
  return 3 + (1 - hits / words.length);
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
