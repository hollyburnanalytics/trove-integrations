import { type ToolDefinition, ToolError, z } from '@ontrove/extend/toolkit';
import {
  ATTRIBUTION,
  boxAround,
  CITYPAGE_COLLECTION,
  CITYPAGE_FIELDS,
  distanceKm,
  ecccError,
  featuresOf,
  itemsUrl,
  matchedCount,
  NAME_CANDIDATE_POOL,
  nameRelevance,
  SEARCH_BOX_DEG,
  toLocation,
} from '../api.ts';

/**
 * `find_location` — resolve a Canadian place name or coordinate to an ECCC
 * forecast site id.
 *
 * ECCC publishes 844 named City Page sites (measured), so most towns have their
 * own forecast point rather than an interpolated grid cell. A name goes through
 * the collection's full-text search and is then re-ranked by how well the site's
 * *name* matches — see {@link nameRelevance} for why the raw order is not good
 * enough. A coordinate pulls every site in a surrounding box and sorts by
 * great-circle distance.
 *
 * The box never truncates in practice: the densest 3° box in Canada holds 53
 * sites against a limit of 200, and 844 nationally.
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
    totalMatched: z.number().nullable(),
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
    const isByCoordinate = latitude !== undefined && longitude !== undefined;
    if (name === undefined && !isByCoordinate) {
      throw new ToolError('Pass either name, or both latitude and longitude.', {
        retryable: false,
      });
    }

    const url = itemsUrl(
      CITYPAGE_COLLECTION,
      isByCoordinate && latitude !== undefined && longitude !== undefined
        ? {
            bbox: boxAround(latitude, longitude, SEARCH_BOX_DEG),
            limit: '200',
            properties: CITYPAGE_FIELDS,
          }
        : {
            q: name ?? '',
            limit: String(NAME_CANDIDATE_POOL),
            properties: CITYPAGE_FIELDS,
          },
    );
    ctx.log('find_location', { name, latitude, longitude, count });
    const body = await ctx.fetchJson(url, { errorMap: ecccError });
    const totalMatched = matchedCount(body);

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
    if (isByCoordinate) {
      rows.sort((a, b) => (a.distanceKm ?? NaN) - (b.distanceKm ?? NaN));
    } else if (name !== undefined) {
      const ranked = rows.map((row, index) => ({
        row,
        index,
        rank: nameRelevance(row.name, name),
      }));
      ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
      rows.splice(0, rows.length, ...ranked.map((entry) => entry.row));
    }
    const locations = rows.slice(0, count);
    const query = isByCoordinate ? `${latitude},${longitude}` : (name ?? '');

    if (locations.length === 0) {
      return {
        text: `No Environment Canada forecast site found for "${query}". Coverage is Canada only.`,
        structured: { query, count: 0, totalMatched, locations: [], attribution: ATTRIBUTION },
      };
    }
    const lines = locations
      .map((l) => {
        const region = l.region ? `, ${l.region}` : '';
        const away = l.distanceKm === null ? '' : ` (${l.distanceKm} km away)`;
        return `  ${l.name ?? l.siteId}${region} → ${l.siteId}${away}`;
      })
      .join('\n');
    // `numberMatched` is a true total, so say "showing N of M" rather than
    // letting the page size read as the number of matching sites.
    const header =
      totalMatched !== null && totalMatched > locations.length
        ? `Showing ${locations.length} of ${totalMatched} site(s) for "${query}"`
        : `${locations.length} site(s) for "${query}"`;
    return {
      text: `${header}:\n${lines}\n\n${ATTRIBUTION}`,
      structured: {
        query,
        count: locations.length,
        totalMatched,
        locations,
        attribution: ATTRIBUTION,
      },
    };
  },
};
