/**
 * The Met — a no-auth hosted MCP server over The Metropolitan Museum of Art's
 * open-access Collection API (collectionapi.metmuseum.org). Open-access object
 * metadata and images are released under CC0. Two read-only surfaces:
 *  - `search_objects` — search the collection (resolving the top hits to details), and
 *  - `get_object`     — full details for one object by id.
 */
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { getJson } from '../lib/http.ts';

const BASE_URL = 'https://collectionapi.metmuseum.org/public/collection/v1';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null => str(value) || null;

/** Shape one raw Met object record into a normalised artwork. */
function toArtwork(object: Record<string, unknown>) {
  return {
    objectId: typeof object.objectID === 'number' ? object.objectID : 0,
    title: str(object.title) || 'Untitled',
    artist: orNull(object.artistDisplayName),
    date: orNull(object.objectDate),
    medium: orNull(object.medium),
    culture: orNull(object.culture),
    department: orNull(object.department),
    classification: orNull(object.classification),
    isPublicDomain: object.isPublicDomain === true,
    image: orNull(object.primaryImage),
    url: orNull(object.objectURL),
  };
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_objects',
      title: 'The Met: Search artworks',
      description:
        "Search The Met's collection by free text (artist, title, culture, keyword). " +
        'Returns matching artworks with artist, date, medium, department, public-domain ' +
        'status, and an image link. Defaults to objects that have an image.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Search text, e.g. "van gogh sunflowers".'),
        hasImages: z.boolean().default(true).describe('Only return objects that have an image.'),
        limit: z.number().int().min(1).max(10).default(8).describe('Max results (1–10).'),
      }),
      output: z.object({
        query: z.string(),
        total: z.number(),
        count: z.number(),
        objects: z.array(
          z.object({
            objectId: z.number(),
            title: z.string(),
            artist: z.string().nullable(),
            date: z.string().nullable(),
            medium: z.string().nullable(),
            culture: z.string().nullable(),
            department: z.string().nullable(),
            classification: z.string().nullable(),
            isPublicDomain: z.boolean(),
            image: z.string().nullable(),
            url: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, hasImages, limit } = args;
        ctx.log('search_objects', { query, hasImages, limit });
        const params = new URLSearchParams({ q: query });
        if (hasImages) params.set('hasImages', 'true');
        const body = await getJson(`${BASE_URL}/search?${params}`, ctx, { service: 'The Met API' });
        const ids = Array.isArray(body.objectIDs)
          ? body.objectIDs.filter((n): n is number => typeof n === 'number')
          : [];
        const total = typeof body.total === 'number' ? body.total : ids.length;
        const objects = (
          await Promise.all(
            ids.slice(0, limit).map((id) =>
              getJson(`${BASE_URL}/objects/${id}`, ctx, { service: 'The Met API' })
                .then(toArtwork)
                .catch(() => undefined),
            ),
          )
        ).filter((object): object is ReturnType<typeof toArtwork> => object !== undefined);
        if (objects.length === 0) {
          return {
            text: `No Met artworks matched "${query}".`,
            structured: { query, total: 0, count: 0, objects: [] },
          };
        }
        const lines = objects
          .map(
            (o) =>
              `  [${o.objectId}] "${o.title}"${o.artist ? ` — ${o.artist}` : ''}${o.date ? ` (${o.date})` : ''}`,
          )
          .join('\n');
        return {
          text: `${objects.length} of ${total} artwork(s) for "${query}":\n${lines}`,
          structured: { query, total, count: objects.length, objects },
        };
      },
    },
    {
      name: 'get_object',
      title: 'The Met: Get an artwork',
      description:
        'Fetch full details for one Met object by its objectId, including the artist bio, ' +
        'dimensions, period, credit line, public-domain status, and image URL.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        objectId: z.number().int().positive().describe('Met object id (from search_objects).'),
      }),
      output: z.object({
        objectId: z.number(),
        title: z.string(),
        artist: z.string().nullable(),
        artistBio: z.string().nullable(),
        date: z.string().nullable(),
        medium: z.string().nullable(),
        dimensions: z.string().nullable(),
        culture: z.string().nullable(),
        period: z.string().nullable(),
        department: z.string().nullable(),
        classification: z.string().nullable(),
        creditLine: z.string().nullable(),
        isPublicDomain: z.boolean(),
        image: z.string().nullable(),
        url: z.string().nullable(),
      }),
      async handler(args, ctx) {
        ctx.log('get_object', { objectId: args.objectId });
        const object = await getJson(`${BASE_URL}/objects/${args.objectId}`, ctx, {
          service: 'The Met API',
        });
        if (typeof object.objectID !== 'number') {
          throw new ToolError(`No Met object ${args.objectId}.`, { retryable: false });
        }
        const detail = {
          ...toArtwork(object),
          artistBio: orNull(object.artistDisplayBio),
          dimensions: orNull(object.dimensions),
          period: orNull(object.period),
          creditLine: orNull(object.creditLine),
        };
        const text =
          `[${detail.objectId}] "${detail.title}"${detail.artist ? ` — ${detail.artist}` : ''}\n` +
          `  ${detail.date ?? ''} · ${detail.medium ?? ''}` +
          `${detail.department ? `\n  ${detail.department}` : ''}` +
          `${detail.image ? `\n  ${detail.image}` : ''}`;
        return { text, structured: detail };
      },
    },
  ],
});
