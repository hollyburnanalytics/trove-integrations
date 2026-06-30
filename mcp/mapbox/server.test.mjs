import { describe, expect, it } from 'bun:test';
import { callTool, withSecret } from '../lib/test-harness.mjs';
import server from './server.ts';

const TOKEN = 'pk.test-token';

// Realistic Mapbox Isochrone response: a FeatureCollection of polygons,
// each carrying its minute value in properties.contour (longest-first).
const ISOCHRONE_BODY = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { contour: 15, color: '#bf4040' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-123.1, 49.3],
            [-123, 49.3],
            [-123, 49.4],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { contour: 5, color: '#4040bf' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-123.08, 49.32],
            [-123.05, 49.32],
            [-123.05, 49.35],
          ],
        ],
      },
    },
  ],
};

// Realistic Mapbox Geocoding (v5) response: features with center [lng, lat].
const GEOCODE_BODY = {
  type: 'FeatureCollection',
  query: ['2185', 'marine', 'dr'],
  features: [
    {
      place_name: '2185 Marine Dr, West Vancouver, British Columbia, Canada',
      relevance: 0.95,
      center: [-123.151, 49.331],
      geometry: { type: 'Point', coordinates: [-123.151, 49.331] },
    },
    {
      place_name: '2185 Marine Drive, Vancouver, British Columbia, Canada',
      relevance: 0.71,
      center: [-123.108, 49.27],
      geometry: { type: 'Point', coordinates: [-123.108, 49.27] },
    },
  ],
};

// Realistic Mapbox Directions (v5) response: one route with legs/steps.
const DIRECTIONS_BODY = {
  routes: [
    {
      duration: 612.3,
      distance: 1430.5,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-123.14, 49.33],
          [-123.1, 49.32],
        ],
      },
      legs: [
        {
          steps: [
            { name: 'Marine Drive' },
            { name: 'Taylor Way' },
            { name: '' },
            { name: 'Marine Drive' },
          ],
        },
      ],
    },
  ],
};

describe('mapbox MCP server', () => {
  it('lists the three tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'directions',
      'geocode',
      'isochrone',
    ]);
  });

  describe('isochrone', () => {
    it('returns the FeatureCollection polygons', async () => {
      const result = await callTool(
        server,
        'isochrone',
        { lng: -123.1, lat: 49.33, contours_minutes: [5, 15], profile: 'walking' },
        withSecret(TOKEN, { json: ISOCHRONE_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.type).toBe('FeatureCollection');
      expect(result.result.structured.features).toHaveLength(2);
      expect(result.result.structured.features[0].properties.contour).toBe(15);
      expect(result.result.text).toContain('2 isochrone polygon(s)');
      expect(result.result.text).toContain('walking');
    });

    it('sorts contour minutes ascending and never leaks the token in the log', async () => {
      let requested = '';
      await callTool(
        server,
        'isochrone',
        { lng: -123.1, lat: 49.33, contours_minutes: [15, 5, 10] },
        withSecret(TOKEN, (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: ISOCHRONE_BODY };
        }),
      );
      expect(requested).toContain('/isochrone/v1/mapbox/walking/-123.1,49.33');
      expect(requested).toContain('contours_minutes=5%2C10%2C15');
      expect(requested).toContain(`access_token=${TOKEN}`);
    });

    it('maps a 401 to a non-retryable token error', async () => {
      const result = await callTool(
        server,
        'isochrone',
        { lng: -123.1, lat: 49.33, contours_minutes: [5] },
        withSecret(TOKEN, { status: 401, json: { message: 'Not Authorized - Invalid Token' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.error).toMatch(/MAPBOX_TOKEN/);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'isochrone',
        { lng: -123.1, lat: 49.33, contours_minutes: [5] },
        withSecret(TOKEN, { status: 500, json: { message: 'Internal Server Error' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('rejects more than four contours before fetching', async () => {
      const result = await callTool(server, 'isochrone', {
        lng: -123.1,
        lat: 49.33,
        contours_minutes: [5, 10, 15, 20, 25],
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an out-of-range longitude before fetching', async () => {
      const result = await callTool(server, 'isochrone', {
        lng: 200,
        lat: 49.33,
        contours_minutes: [5],
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('geocode', () => {
    it('returns ranked matches with lng/lat from feature centers', async () => {
      const result = await callTool(
        server,
        'geocode',
        { query: '2185 Marine Dr, West Vancouver' },
        withSecret(TOKEN, { json: GEOCODE_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.query).toBe('2185 Marine Dr, West Vancouver');
      expect(result.result.structured.results[0]).toEqual({
        place_name: '2185 Marine Dr, West Vancouver, British Columbia, Canada',
        relevance: 0.95,
        lng: -123.151,
        lat: 49.331,
      });
      expect(result.result.text).toContain('2 match(es)');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'geocode',
        { query: 'nowhere at all' },
        withSecret(TOKEN, { json: { type: 'FeatureCollection', features: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no geocoding matches/i);
    });

    it('forwards the country and proximity params', async () => {
      let requested = '';
      await callTool(
        server,
        'geocode',
        { query: 'cafe', country: 'US', limit: 3, proximity: '-123.1,49.34' },
        withSecret(TOKEN, (url) => {
          if (!url.includes('/internal/secret')) requested = url;
          return { json: GEOCODE_BODY };
        }),
      );
      expect(requested).toContain('/geocoding/v5/mapbox.places/cafe.json');
      expect(requested).toContain('country=US');
      expect(requested).toContain('limit=3');
      expect(requested).toContain('proximity=-123.1%2C49.34');
    });

    it('maps a 422 to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'geocode',
        { query: 'x' },
        withSecret(TOKEN, { status: 422, json: { message: 'Query too long' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('rejects an over-limit value before fetching', async () => {
      const result = await callTool(server, 'geocode', { query: 'cafe', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('directions', () => {
    it('returns duration, distance, geometry, and step names', async () => {
      const result = await callTool(
        server,
        'directions',
        { origin: '-123.14,49.33', destination: '-123.1,49.32', profile: 'driving', steps: true },
        withSecret(TOKEN, { json: DIRECTIONS_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.found).toBe(true);
      expect(result.result.structured.duration_seconds).toBe(612.3);
      expect(result.result.structured.distance_meters).toBe(1430.5);
      expect(result.result.structured.geometry.type).toBe('LineString');
      // Empty step names are filtered out.
      expect(result.result.structured.steps).toEqual([
        'Marine Drive',
        'Taylor Way',
        'Marine Drive',
      ]);
      expect(result.result.text).toContain('10.2 min');
      expect(result.result.text).toContain('1.43 km');
    });

    it('omits steps when not requested', async () => {
      const result = await callTool(
        server,
        'directions',
        { origin: '-123.14,49.33', destination: '-123.1,49.32' },
        withSecret(TOKEN, { json: DIRECTIONS_BODY }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.steps).toBeUndefined();
    });

    it('reports no route when the routes array is empty', async () => {
      const result = await callTool(
        server,
        'directions',
        { origin: '-123.14,49.33', destination: '-123.1,49.32' },
        withSecret(TOKEN, { json: { routes: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.found).toBe(false);
      expect(result.result.structured.duration_seconds).toBeNull();
      expect(result.result.structured.geometry).toBeNull();
      expect(result.result.text).toMatch(/no walking route/i);
    });

    it('maps a 429 to a retryable error', async () => {
      const result = await callTool(
        server,
        'directions',
        { origin: '-123.14,49.33', destination: '-123.1,49.32' },
        withSecret(TOKEN, { status: 429, json: { message: 'Rate limit exceeded' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('rejects an invalid profile before fetching', async () => {
      const result = await callTool(server, 'directions', {
        origin: '-123.14,49.33',
        destination: '-123.1,49.32',
        profile: 'flying',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
