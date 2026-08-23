import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { callTool } from '../lib/test-harness.mjs';
import server from './extension.ts';

/**
 * Regression tests over **verbatim captured ECCC responses** (`fixtures/`).
 *
 * Every case here corresponds to a defect found by probing the live API — each
 * one a confidently wrong answer under an HTTP 200, which the hand-written
 * fixtures in `extension.test.mjs` could not catch because they encoded the same
 * mistaken belief the code did.
 */

const load = async (name) =>
  JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const loadText = async (name) => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

const SITE = await load('citypage-bc99.json');
const SEARCH = await load('citypage-search-west-vancouver.json');
const SWOB_OBS = await load('swob-obs-point-atkinson.json');
const WMS_OUT_OF_RANGE = await loadText('wms-out-of-range.xml');

describe('eccc-weather against captured live responses', () => {
  describe('forecast', () => {
    it('converts City Page kPa pressure to hPa', async () => {
      // The raw leaf is 101.5 with units "kPa"; observations reports SWOB in
      // hPa, so publishing both unlabelled would differ by a factor of ten.
      const raw = SITE.properties.currentConditions.pressure;
      expect(raw.units.en).toBe('kPa');
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: SITE });
      expect(result.ok).toBe(true);
      expect(result.result.structured.current.pressure).toBeCloseTo(raw.value.en * 10, 1);
      expect(result.result.structured.current.pressure).toBeGreaterThan(900);
    });

    it('suppresses the stale summer windChill ECCC leaves in the payload', async () => {
      // bc-99 carried windChill -2 while the temperature was above 20 °C.
      expect(SITE.properties.currentConditions.windChill.value.en).toBeLessThan(0);
      expect(SITE.properties.currentConditions.temperature.value.en).toBeGreaterThan(15);
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: SITE });
      expect(result.result.structured.current.windChill).toBeNull();
    });

    it('does not offer a period precipitation probability the API never sends', async () => {
      // `pop` appears in the collection's queryables but in no live period.
      expect(JSON.stringify(SITE.properties.forecastGroup.forecasts)).not.toContain('"pop"');
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: SITE });
      for (const period of result.result.structured.periods) {
        expect(period).not.toHaveProperty('precipProbability');
      }
    });

    it('exposes per-period UV and the site url from the real payload', async () => {
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: SITE });
      const s = result.result.structured;
      expect(s.url).toContain('weather.gc.ca');
      expect(s.periods.some((p) => p.uvIndex !== null)).toBe(true);
      // The observation time is distinct from the document publish time.
      expect(s.current.observedAt).not.toBeNull();
    });
  });

  describe('find_location', () => {
    it('reports the true match total, not the page size', async () => {
      expect(SEARCH.numberMatched).toBeGreaterThan(5);
      const result = await callTool(
        server,
        'find_location',
        { name: 'West Vancouver', count: 4 },
        { json: SEARCH },
      );
      const s = result.result.structured;
      expect(s.count).toBe(4);
      expect(s.totalMatched).toBe(SEARCH.numberMatched);
      expect(result.result.text).toContain(`of ${SEARCH.numberMatched} site(s)`);
    });

    it('ranks name matches above region-only matches', async () => {
      // `q=` is full-text over the region too, so "West Vancouver" matches
      // Tofino and Ucluelet — both on "West Vancouver Island".
      const apiOrder = SEARCH.features.map((f) => f.properties.name.en);
      expect(apiOrder.slice(0, 4)).toContain('Ucluelet');
      const result = await callTool(
        server,
        'find_location',
        { name: 'West Vancouver', count: 4 },
        { json: SEARCH },
      );
      const names = result.result.structured.locations.map((l) => l.name);
      expect(names[0]).toBe('West Vancouver');
      expect(names).not.toContain('Ucluelet');
      expect(names).not.toContain('Tofino');
    });
  });

  describe('observations', () => {
    it('reads the real SWOB record and names the wind averaging window', async () => {
      const observed = SWOB_OBS.features[0].properties;
      const result = await callTool(
        server,
        'observations',
        { latitude: 49.3303, longitude: -123.2647 },
        (url) =>
          url.includes('/swob-realtime/')
            ? { json: SWOB_OBS }
            : {
                json: {
                  features: [
                    {
                      id: 'PT',
                      geometry: { type: 'Point', coordinates: [-123.2647, 49.3303] },
                      properties: { name: 'POINT ATKINSON' },
                    },
                  ],
                },
              },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.stationName).toBe('POINT ATKINSON');
      expect(s.airTemperature).toBe(observed.air_temp);
      // Units are declared per-field upstream and match the labels we publish.
      expect(observed['air_temp-uom']).toBe('°C');
      expect(observed['stn_pres-uom']).toBe('hPa');
      expect(s.units.pressure).toBe('hPa');
      if (s.windSpeed !== null) expect(s.windAveragingWindow).not.toBeNull();
    });
  });

  describe('model_point', () => {
    it('treats the real out-of-range WMS XML exception as no data', async () => {
      // GeoMet answers an out-of-horizon TIME with HTTP 200 + XML.
      expect(WMS_OUT_OF_RANGE).toContain('ServiceException');
      const result = await callTool(
        server,
        'model_point',
        { latitude: 49.3277, longitude: -123.1636, variables: ['cloudCover'], hours: 2 },
        { text: WMS_OUT_OF_RANGE, headers: { 'content-type': 'text/xml' } },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.missingHours).toBe(2);
      // Every hour empty means the point is outside the domain, not past the
      // horizon — asserting the horizon here would be a confident falsehood.
      expect(s.coverage).toBe('outsideDomain');
      expect(result.result.text).toContain('outside the model domain');
      expect(result.result.text).not.toContain('past the');
    });
  });
});
