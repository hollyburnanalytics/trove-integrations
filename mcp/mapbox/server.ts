/**
 * Mapbox Geo — a hosted MCP server over the Mapbox APIs (`api.mapbox.com`):
 * travel-time isochrones, forward geocoding, and directions.
 *
 * Ported from the Groundwork isochrone/geocode/directions ingest. The Mapbox
 * access token is NOT baked into the bundle — it is redeemed at call time from
 * the encrypted vault via `ctx.requireSecret('MAPBOX_TOKEN')` and passed as the
 * `access_token` query param (never logged). Set it once with
 * `trove secret set mapbox MAPBOX_TOKEN <pk....>`.
 *
 * Coordinates are longitude,latitude everywhere (Mapbox convention). Isochrone
 * features arrive longest-time-first, so callers should key on
 * `properties.contour`, not array index.
 */
import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/** Mapbox API host. */
const BASE_URL = 'https://api.mapbox.com';

/**
 * GET a Mapbox URL and parse JSON, surfacing the upstream status + message.
 * Routed through `ctx.fetchJson`; Mapbox's per-status semantics are preserved
 * via `errorMap` (401/403 → check token, non-retryable; other non-2xx → surface
 * status + message, retryable only for 429/5xx).
 */
async function getJson(url: string, ctx: ToolContext): Promise<Record<string, unknown>> {
  const parsed = await ctx.fetchJson(url, {
    init: { headers: { accept: 'application/json' } },
    errorMap(res, body) {
      let upstream = '';
      try {
        const j = JSON.parse(body) as { message?: unknown };
        if (typeof j.message === 'string') upstream = j.message;
      } catch {
        upstream = body.slice(0, 120);
      }
      if (res.status === 401 || res.status === 403) {
        return new ToolError(
          `Mapbox rejected the request (${res.status})${upstream ? `: ${upstream}` : ''} — check MAPBOX_TOKEN.`,
          { retryable: false },
        );
      }
      return new ToolError(`Mapbox API error ${res.status}${upstream ? `: ${upstream}` : ''}.`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    },
  });
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

export default defineMcpServer({
  tools: [
    {
      name: 'isochrone',
      title: 'Mapbox: Isochrone',
      description:
        'Return GeoJSON polygons of the area reachable within N minutes of a point ' +
        '(walk/drive/cycle travel time). Coordinates are longitude,latitude. Up to ' +
        '4 contour times per call, each 1–60 minutes. Each polygon carries its ' +
        'minute value in properties.contour.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        lng: z.number().min(-180).max(180).describe('Longitude of the center point.'),
        lat: z.number().min(-90).max(90).describe('Latitude of the center point.'),
        contours_minutes: z
          .array(z.number().int().min(1).max(60))
          .min(1)
          .max(4)
          .describe('1–4 travel-time contours in minutes, e.g. [5, 10, 15].'),
        profile: z
          .enum(['walking', 'driving', 'cycling'])
          .default('walking')
          .describe('Routing profile.'),
      }),
      output: z.object({
        type: z.literal('FeatureCollection'),
        features: z.array(z.record(z.unknown())),
      }),
      async handler(args, ctx) {
        const { lng, lat, contours_minutes, profile } = args;
        const token = await ctx.requireSecret('MAPBOX_TOKEN');
        const params = new URLSearchParams({
          contours_minutes: [...contours_minutes].sort((a, b) => a - b).join(','),
          polygons: 'true',
          denoise: '1',
          generalize: '25',
          access_token: token,
        });
        const url = `${BASE_URL}/isochrone/v1/mapbox/${profile}/${lng},${lat}?${params.toString()}`;
        ctx.log('isochrone', { lng, lat, contours_minutes, profile }); // token NOT logged
        const body = await getJson(url, ctx);
        const features = Array.isArray(body.features)
          ? (body.features as Array<Record<string, unknown>>)
          : [];
        return {
          text: `${features.length} isochrone polygon(s) for ${profile} from ${lng},${lat} at ${contours_minutes.join(', ')} min.`,
          structured: { type: 'FeatureCollection' as const, features },
        };
      },
    },
    {
      name: 'geocode',
      title: 'Mapbox: Geocode',
      description:
        'Resolve a free-text address or place to coordinates. Returns best matches ' +
        'with place_name, relevance (0–1 confidence), and lon/lat. Biased to Canada ' +
        'by default.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .min(1)
          .describe('Address or place, e.g. "2185 Marine Dr, West Vancouver".'),
        country: z.string().default('CA').describe('ISO-2 country filter, e.g. "CA".'),
        limit: z.number().int().min(1).max(10).default(5).describe('Max results (1–10).'),
        proximity: z.string().optional().describe('Bias point "lng,lat", e.g. "-123.1,49.34".'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        results: z.array(
          z.object({
            place_name: z.string(),
            relevance: z.number(),
            lng: z.number(),
            lat: z.number(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, country, limit, proximity } = args;
        const token = await ctx.requireSecret('MAPBOX_TOKEN');
        const params = new URLSearchParams({
          access_token: token,
          country,
          types: 'address,poi',
          limit: String(limit),
        });
        if (proximity) params.set('proximity', proximity);
        const url = `${BASE_URL}/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.toString()}`;
        ctx.log('geocode', { query, country, limit }); // token NOT logged
        const body = await getJson(url, ctx);
        const rawFeatures = Array.isArray(body.features) ? body.features : [];
        const results = rawFeatures.flatMap((f) => {
          const feat = f as { place_name?: unknown; relevance?: unknown; center?: unknown };
          const center = Array.isArray(feat.center) ? feat.center : [];
          const lng = typeof center[0] === 'number' ? center[0] : null;
          const lat = typeof center[1] === 'number' ? center[1] : null;
          if (lng === null || lat === null) return [];
          return [
            {
              place_name: typeof feat.place_name === 'string' ? feat.place_name : '',
              relevance: typeof feat.relevance === 'number' ? feat.relevance : 0,
              lng,
              lat,
            },
          ];
        });
        if (results.length === 0) {
          return {
            text: `No geocoding matches for "${query}".`,
            structured: { query, count: 0, results: [] },
          };
        }
        const lines = results
          .map((r) => `  ${r.place_name} (${r.relevance.toFixed(2)}) → ${r.lng},${r.lat}`)
          .join('\n');
        return {
          text: `${results.length} match(es) for "${query}":\n${lines}`,
          structured: { query, count: results.length, results },
        };
      },
    },
    {
      name: 'directions',
      title: 'Mapbox: Directions',
      description:
        'Compute a route between two points (walk/drive/cycle): travel time, ' +
        'distance, and the route geometry. Coordinates are "lng,lat". Optionally ' +
        'include turn-by-turn step street names.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        origin: z.string().describe('Start "lng,lat", e.g. "-123.14,49.33".'),
        destination: z.string().describe('End "lng,lat", e.g. "-123.10,49.32".'),
        profile: z
          .enum(['walking', 'driving', 'cycling'])
          .default('walking')
          .describe('Routing profile.'),
        steps: z.boolean().default(false).describe('Include turn-by-turn step names.'),
      }),
      output: z.object({
        found: z.boolean(),
        duration_seconds: z.number().nullable(),
        distance_meters: z.number().nullable(),
        geometry: z.record(z.unknown()).nullable(),
        steps: z.array(z.string()).optional(),
      }),
      async handler(args, ctx) {
        const { origin, destination, profile, steps } = args;
        const token = await ctx.requireSecret('MAPBOX_TOKEN');
        const params = new URLSearchParams({
          geometries: 'geojson',
          overview: 'full',
          access_token: token,
        });
        if (steps) params.set('steps', 'true');
        const coords = `${encodeURIComponent(origin)};${encodeURIComponent(destination)}`;
        const url = `${BASE_URL}/directions/v5/mapbox/${profile}/${coords}?${params.toString()}`;
        ctx.log('directions', { origin, destination, profile, steps }); // token NOT logged
        const body = await getJson(url, ctx);
        const routes = Array.isArray(body.routes) ? body.routes : [];
        const route = routes[0] as
          | { duration?: unknown; distance?: unknown; geometry?: unknown; legs?: unknown }
          | undefined;
        if (!route) {
          return {
            text: `No ${profile} route from ${origin} to ${destination}.`,
            structured: {
              found: false,
              duration_seconds: null,
              distance_meters: null,
              geometry: null,
            },
          };
        }
        const duration = typeof route.duration === 'number' ? route.duration : null;
        const distance = typeof route.distance === 'number' ? route.distance : null;
        const geometry =
          typeof route.geometry === 'object' && route.geometry !== null
            ? (route.geometry as Record<string, unknown>)
            : null;
        let stepNames: string[] | undefined;
        if (steps) {
          const legs = Array.isArray(route.legs) ? route.legs : [];
          stepNames = legs.flatMap((l) => {
            const legSteps = (l as { steps?: unknown }).steps;
            return Array.isArray(legSteps)
              ? legSteps
                  .map((s) => (s as { name?: unknown }).name)
                  .filter((n): n is string => typeof n === 'string' && n.length > 0)
              : [];
          });
        }
        const mins = duration !== null ? (duration / 60).toFixed(1) : '?';
        const km = distance !== null ? (distance / 1000).toFixed(2) : '?';
        const structured: {
          found: boolean;
          duration_seconds: number | null;
          distance_meters: number | null;
          geometry: Record<string, unknown> | null;
          steps?: string[];
        } = { found: true, duration_seconds: duration, distance_meters: distance, geometry };
        if (stepNames) structured.steps = stepNames;
        return {
          text: `${profile} route: ${mins} min, ${km} km${stepNames ? ` via ${stepNames.slice(0, 8).join(' → ')}` : ''}.`,
          structured,
        };
      },
    },
  ],
});
