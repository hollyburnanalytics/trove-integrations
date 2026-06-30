import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// A realistic USGS FDSN GeoJSON feed — coordinates are [lng, lat, depthKm].
const FEED = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        place: '70 km E of Tokyo, Japan',
        mag: 6.2,
        time: 1_700_000_000_000,
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/abc123',
      },
      geometry: { type: 'Point', coordinates: [140.5, 35.6, 42.3] },
    },
    {
      type: 'Feature',
      properties: {
        place: '10 km S of Ridgecrest, CA',
        mag: 5.1,
        time: 1_700_086_400_000,
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/def456',
      },
      geometry: { type: 'Point', coordinates: [-117.6, 35.7, 8] },
    },
  ],
};

describe('usgs-quakes MCP server', () => {
  it('lists the recent_quakes tool', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['recent_quakes']);
  });

  describe('recent_quakes', () => {
    it('returns mapped quakes from the USGS feed', async () => {
      const result = await callTool(server, 'recent_quakes', {}, { json: FEED });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);

      const [first, second] = result.result.structured.quakes;
      expect(first.place).toBe('70 km E of Tokyo, Japan');
      expect(first.magnitude).toBe(6.2);
      expect(first.longitude).toBe(140.5);
      expect(first.latitude).toBe(35.6);
      expect(first.depthKm).toBe(42.3);
      expect(first.url).toBe('https://earthquake.usgs.gov/earthquakes/eventpage/abc123');
      // time is the ISO string for the epoch-millis `time` field.
      expect(first.time).toBe(new Date(1_700_000_000_000).toISOString());
      expect(second.place).toBe('10 km S of Ridgecrest, CA');

      expect(result.result.text).toContain('2 earthquake(s)');
      expect(result.result.text).toContain('Tokyo');
    });

    it('builds the USGS query with defaults and no geo filter', async () => {
      let requested = '';
      await callTool(server, 'recent_quakes', {}, (url) => {
        requested = url;
        return { json: FEED };
      });
      expect(requested).toContain('https://earthquake.usgs.gov/fdsnws/event/1/query?');
      expect(requested).toContain('format=geojson');
      expect(requested).toContain('minmagnitude=4.5');
      expect(requested).toContain('orderby=time');
      expect(requested).toContain('limit=20');
      // No center point given → no geographic parameters.
      expect(requested).not.toContain('latitude=');
      expect(requested).not.toContain('maxradiuskm=');
    });

    it('adds geographic parameters when a center point is provided', async () => {
      let requested = '';
      await callTool(
        server,
        'recent_quakes',
        { latitude: 35.6, longitude: 139.7, radiusKm: 300, minMagnitude: 5, limit: 5 },
        (url) => {
          requested = url;
          return { json: FEED };
        },
      );
      expect(requested).toContain('latitude=35.6');
      expect(requested).toContain('longitude=139.7');
      expect(requested).toContain('maxradiuskm=300');
      expect(requested).toContain('minmagnitude=5');
      expect(requested).toContain('limit=5');
    });

    it('reports an empty result cleanly', async () => {
      const result = await callTool(server, 'recent_quakes', {}, { json: { features: [] } });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.quakes).toEqual([]);
      expect(result.result.text).toMatch(/no earthquakes/i);
    });

    it('tolerates missing/partial fields with defaults', async () => {
      const result = await callTool(
        server,
        'recent_quakes',
        {},
        {
          json: {
            features: [{ properties: {}, geometry: { coordinates: [] } }],
          },
        },
      );
      expect(result.ok).toBe(true);
      const q = result.result.structured.quakes[0];
      expect(q.place).toBe('Unknown location');
      expect(q.magnitude).toBe(0);
      expect(q.time).toBe('');
      expect(q.url).toBe('');
      expect(q.longitude).toBe(0);
      expect(q.latitude).toBe(0);
      expect(q.depthKm).toBe(0);
    });

    it('maps a 400 to a non-retryable error', async () => {
      const result = await callTool(server, 'recent_quakes', {}, { status: 400 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/rejected the query/i);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(server, 'recent_quakes', {}, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/temporarily unavailable/i);
    });

    it('rejects an out-of-range magnitude before fetching', async () => {
      const result = await callTool(server, 'recent_quakes', { minMagnitude: 15 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a non-integer days value before fetching', async () => {
      const result = await callTool(server, 'recent_quakes', { days: 3.5 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an out-of-range latitude before fetching', async () => {
      const result = await callTool(server, 'recent_quakes', { latitude: 120 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
