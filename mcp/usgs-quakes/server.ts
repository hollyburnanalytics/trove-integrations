import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * USGS Earthquakes — a no-auth hosted MCP server over the public USGS feed.
 * See docs-site/.../examples/usgs-earthquakes.md for the walkthrough.
 */

/**
 * A USGS FDSN GeoJSON response (lenient — every field defaulted/optional). The
 * malformed-data guard is handled by `ctx.fetchJson` (bad JSON) and by this
 * schema (missing `features`).
 */
const QuakeFeed = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            place: z.string().nullish(),
            mag: z.number().nullish(),
            time: z.number().nullish(),
            url: z.string().nullish(),
          })
          .nullish(),
        geometry: z.object({ coordinates: z.array(z.number()).default([]) }).nullish(),
      }),
    )
    .default([]),
});

export default defineMcpServer({
  tools: [
    {
      name: 'recent_quakes',
      title: 'USGS: Recent earthquakes',
      description:
        'List recent earthquakes from the USGS feed, optionally filtered by minimum ' +
        'magnitude and a radius around a latitude/longitude. Use for questions like ' +
        "'any big quakes near Tokyo this week?'.",
      // Read-only is auto-derived, but this tool reaches a public third-party API,
      // so we declare openWorldHint explicitly.
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        minMagnitude: z
          .number()
          .min(0)
          .max(10)
          .default(4.5)
          .describe('Minimum magnitude. Defaults to 4.5 (newsworthy quakes).'),
        days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(7)
          .describe('How many days back to search (1–30). Defaults to 7.'),
        latitude: z.number().min(-90).max(90).optional().describe('Center latitude.'),
        longitude: z.number().min(-180).max(180).optional().describe('Center longitude.'),
        radiusKm: z
          .number()
          .min(1)
          .max(20000)
          .default(500)
          .describe('Search radius in km around the center point. Used only with lat/long.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max quakes to return.'),
      }),
      output: z.object({
        count: z.number(),
        quakes: z.array(
          z.object({
            place: z.string(),
            magnitude: z.number(),
            time: z.string(),
            url: z.string(),
            longitude: z.number(),
            latitude: z.number(),
            depthKm: z.number(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { minMagnitude, days, latitude, longitude, radiusKm, limit } = args;

        const starttime = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

        const params = new URLSearchParams({
          format: 'geojson',
          starttime,
          minmagnitude: String(minMagnitude),
          orderby: 'time',
          limit: String(limit),
        });
        // Geographic filtering is optional — only when a center point is given.
        if (latitude !== undefined && longitude !== undefined) {
          params.set('latitude', String(latitude));
          params.set('longitude', String(longitude));
          params.set('maxradiuskm', String(radiusKm));
        }

        const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`;
        ctx.log('recent_quakes querying USGS', { starttime, minMagnitude, limit });

        const body = await ctx.fetchJson(url, {
          schema: QuakeFeed,
          init: { headers: { accept: 'application/json' } },
          errorMap: (res) =>
            res.status === 400
              ? new ToolError('USGS rejected the query parameters.', { retryable: false })
              : new ToolError('USGS feed is temporarily unavailable.', { retryable: true }),
        });

        const quakes = body.features.flatMap((f) => {
          const coords = f.geometry?.coordinates;
          if (!Array.isArray(coords)) return [];
          const [lng, lat, depth] = coords;
          const props = f.properties ?? {};
          return [
            {
              place: typeof props.place === 'string' ? props.place : 'Unknown location',
              magnitude: typeof props.mag === 'number' ? props.mag : 0,
              time: typeof props.time === 'number' ? new Date(props.time).toISOString() : '',
              url: typeof props.url === 'string' ? props.url : '',
              longitude: typeof lng === 'number' ? lng : 0,
              latitude: typeof lat === 'number' ? lat : 0,
              depthKm: typeof depth === 'number' ? depth : 0,
            },
          ];
        });

        if (quakes.length === 0) {
          return {
            text: `No earthquakes ≥ M${minMagnitude} in the last ${days} day(s).`,
            structured: { count: 0, quakes: [] },
          };
        }

        const lines = quakes
          .slice(0, 10)
          .map((q) => `  M${q.magnitude.toFixed(1)} — ${q.place} (${q.time.slice(0, 16)}Z)`)
          .join('\n');

        return {
          text:
            `${quakes.length} earthquake(s) ≥ M${minMagnitude} in the last ${days} day(s):\n` +
            lines,
          structured: { count: quakes.length, quakes },
        };
      },
    },
  ],
});
