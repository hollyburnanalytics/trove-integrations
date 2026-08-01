import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import {
  ATTRIBUTION,
  boxAround,
  CITYPAGE_COLLECTION,
  distanceKm,
  ecccError,
  featuresOf,
  itemsUrl,
  SEARCH_BOX_DEG,
  toLocation,
} from '../api.ts';

/**
 * `find_location` — resolve a Canadian place name or coordinate to an ECCC
 * forecast site id.
 *
 * ECCC publishes roughly 800 named City Page sites, so most towns have their
 * own forecast point rather than an interpolated grid cell. A name goes through
 * the collection's ranked full-text search; a coordinate pulls every site in a
 * surrounding box and sorts by great-circle distance.
 */
export const findLocation: ToolDefinition = {
  name: 'find_location',
  title: 'ECCC: Find forecast location',
  description:
    'Resolve a Canadian place name (or a latitude/longitude) to an Environment ' +
    'Canada forecast site id, for use with the forecast tool. Pass either name, ' +
    'or both latitude and longitude to get the nearest sites ranked by distance. ' +
    'Canada only.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Place name, e.g. "West Vancouver". Omit if using coordinates.'),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Latitude in decimal degrees. Requires longitude.'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Longitude in decimal degrees. Requires latitude.'),
    count: z.number().int().min(1).max(10).default(5).describe('Max matches (1–10).'),
  }),
  output: z.object({
    query: z.string(),
    count: z.number(),
    locations: z.array(
      z.object({
        siteId: z.string(),
        name: z.string().nullable(),
        region: z.string().nullable(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        distanceKm: z.number().nullable(),
      }),
    ),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { name, latitude, longitude, count } = args as {
      name?: string;
      latitude?: number;
      longitude?: number;
      count: number;
    };
    const byCoordinate = latitude !== undefined && longitude !== undefined;
    if (name === undefined && !byCoordinate) {
      throw new ToolError('Pass either name, or both latitude and longitude.', {
        retryable: false,
      });
    }

    const url =
      byCoordinate && latitude !== undefined && longitude !== undefined
        ? itemsUrl(CITYPAGE_COLLECTION, {
            bbox: boxAround(latitude, longitude, SEARCH_BOX_DEG),
            limit: '200',
          })
        : itemsUrl(CITYPAGE_COLLECTION, { q: name ?? '', limit: String(count) });
    ctx.log('find_location', { name, latitude, longitude, count });
    const body = await ctx.fetchJson(url, { errorMap: ecccError });

    const rows = featuresOf(body).map((feature) => {
      const location = toLocation(feature);
      const away =
        latitude !== undefined &&
        longitude !== undefined &&
        location.latitude !== null &&
        location.longitude !== null
          ? Math.round(
              distanceKm(latitude, longitude, location.latitude, location.longitude) * 10,
            ) / 10
          : null;
      return { ...location, distanceKm: away };
    });
    if (byCoordinate) {
      rows.sort((a, b) => (a.distanceKm ?? Number.NaN) - (b.distanceKm ?? Number.NaN));
    }
    const locations = rows.slice(0, count);
    const query = byCoordinate ? `${latitude},${longitude}` : (name ?? '');

    if (locations.length === 0) {
      return {
        text: `No Environment Canada forecast site found for "${query}". Coverage is Canada only.`,
        structured: { query, count: 0, locations: [], attribution: ATTRIBUTION },
      };
    }
    const lines = locations
      .map(
        (l) =>
          `  ${l.name ?? l.siteId}${l.region ? `, ${l.region}` : ''} → ${l.siteId}` +
          `${l.distanceKm === null ? '' : ` (${l.distanceKm} km away)`}`,
      )
      .join('\n');
    return {
      text: `${locations.length} site(s) for "${query}":\n${lines}\n\n${ATTRIBUTION}`,
      structured: { query, count: locations.length, locations, attribution: ATTRIBUTION },
    };
  },
};
