import { describe, expect, it } from 'vitest';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** ECCC wraps leaves bilingually; fixtures mirror the real payload shapes. */
const bi = (value) => ({ en: value, fr: value });
const measure = (value, units) => ({ units: bi(units), value: bi(value) });

const SITE_FEATURE = {
  id: 'bc-99',
  geometry: { type: 'Point', coordinates: [-123.16, 49.33] },
  properties: { name: bi('West Vancouver'), region: bi('Metro Vancouver') },
};

const SITES_BODY = {
  features: [
    SITE_FEATURE,
    {
      id: 'bc-74',
      geometry: { type: 'Point', coordinates: [-123.11, 49.26] },
      properties: { name: bi('Vancouver'), region: bi('Metro Vancouver') },
    },
  ],
};

const SITE_BODY = {
  id: 'bc-99',
  geometry: { type: 'Point', coordinates: [-123.16, 49.33] },
  properties: {
    name: bi('West Vancouver'),
    region: bi('Metro Vancouver'),
    lastUpdated: '2026-08-01T02:00:45Z',
    riseSet: {
      sunrise: bi('2026-08-01T12:44:00Z'),
      sunset: bi('2026-08-02T03:53:00Z'),
    },
    currentConditions: {
      condition: bi('Mainly Clear'),
      temperature: measure(18.4, 'C'),
      relativeHumidity: measure(62, '%'),
      dewpoint: measure(11.1, 'C'),
      // ECCC reports a calm wind as the literal string, not 0.
      wind: { speed: measure('calm', 'km/h'), direction: { value: bi('WNW') } },
    },
    hourlyForecastGroup: {
      hourlyForecasts: [
        {
          timestamp: '2026-08-01T03:00:00Z',
          condition: bi('Mainly sunny'),
          temperature: measure(22, 'C'),
          lop: measure(0, '%'),
          wind: {
            speed: measure(5, 'km/h'),
            direction: { value: bi('VR'), windDirFull: bi('Variable direction') },
          },
        },
        {
          timestamp: '2026-08-01T04:00:00Z',
          condition: bi('Clear'),
          temperature: measure(20, 'C'),
          lop: measure(10, '%'),
          wind: { speed: measure(12, 'km/h'), direction: { value: bi('SW') } },
        },
      ],
    },
    forecastGroup: {
      forecasts: [
        {
          period: { textForecastName: bi('Tonight') },
          textSummary: bi('Clear. Low 16.'),
          temperatures: { temperature: [{ ...measure(16, 'C'), class: bi('low') }] },
          winds: {
            periods: [
              { speed: measure(15, 'km/h'), gust: measure(0, 'km/h'), direction: bi('SW') },
            ],
          },
          abbreviatedForecast: { icon: { format: 'gif', value: 12 } },
        },
        {
          period: { textForecastName: bi('Saturday') },
          textSummary: bi('Sunny. High 24.'),
          temperatures: { temperature: [{ ...measure(24, 'C'), class: bi('high') }] },
          winds: { periods: [] },
          abbreviatedForecast: { icon: { format: 'gif', value: 19 } },
        },
      ],
    },
    warnings: [],
  },
};

/** SITE_BODY with a chosen temperature and a sub-zero wind chill. */
const siteAtTemperature = (degrees) => ({
  ...SITE_BODY,
  properties: {
    ...SITE_BODY.properties,
    currentConditions: {
      ...SITE_BODY.properties.currentConditions,
      temperature: measure(degrees, 'C'),
      windChill: { value: bi(-14) },
    },
  },
});

/** SITE_BODY with a pressure leaf in the given unit. */
const siteWithPressure = (units, value) => ({
  ...SITE_BODY,
  properties: {
    ...SITE_BODY.properties,
    currentConditions: {
      ...SITE_BODY.properties.currentConditions,
      pressure: { units: bi(units), value: bi(value) },
    },
  },
});

const AQHI_STATIONS_BODY = {
  features: [
    {
      id: 'JBRIK',
      geometry: { type: 'Point', coordinates: [-123.113_889, 49.261_111] },
      properties: { location_id: 'JBRIK', location_name_en: 'Metro Vancouver - NW' },
    },
    {
      id: 'FAR',
      geometry: { type: 'Point', coordinates: [-121, 49] },
      properties: { location_id: 'FAR', location_name_en: 'Somewhere Else' },
    },
  ],
};

const AQHI_OBSERVATIONS_BODY = {
  features: [
    {
      properties: {
        location_id: 'JBRIK',
        observation_datetime: '2026-08-01T02:00:00Z',
        aqhi: 2.4,
      },
    },
  ],
};

/** The current UTC hour, and stamps relative to it. */
const HOUR_MS = 3_600_000;
const NOW_HOUR = (() => {
  const at = new Date();
  at.setUTCMinutes(0, 0, 0);
  return at;
})();
const hourStamp = (offsetHours) =>
  new Date(NOW_HOUR.getTime() + offsetHours * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Anchored to the clock, because the tool drops elapsed hours — fixed
 * timestamps would silently start failing once they fell into the past.
 */
const AQHI_FORECASTS_BODY = {
  features: [
    // Newest run, deliberately out of order to exercise the re-sort.
    {
      properties: {
        publication_datetime: hourStamp(0),
        forecast_datetime: hourStamp(1),
        aqhi: 8,
      },
    },
    {
      properties: {
        publication_datetime: hourStamp(0),
        forecast_datetime: hourStamp(0),
        aqhi: 2,
      },
    },
    // A superseded run ECCC still serves alongside the current one.
    {
      properties: {
        publication_datetime: hourStamp(-72),
        forecast_datetime: hourStamp(-71),
        aqhi: 5,
      },
    },
  ],
};

const SWOB_STATIONS_BODY = {
  features: [
    {
      id: 'PT-ATK',
      geometry: { type: 'Point', coordinates: [-123.264_704, 49.330_352] },
      properties: { name: 'POINT ATKINSON' },
    },
    {
      id: 'FAR',
      geometry: { type: 'Point', coordinates: [-122.5, 49.9] },
      properties: { name: 'SOMEWHERE FAR' },
    },
  ],
};

/**
 * A real SWOB record carries ~200 columns. This mirrors the awkward part: the
 * preferred 10-minute wind window is null while shorter windows report.
 */
const SWOB_OBS_BODY = {
  features: [
    {
      properties: {
        'stn_nam-value': 'POINT ATKINSON',
        obs_date_tm: '2026-08-01T03:38:00.000Z',
        air_temp: 21.5,
        dwpt_temp: 12,
        rel_hum: 55,
        stn_pres: 1011.9,
        pcpn_amt_pst1hr: 0,
        avg_wnd_spd_10m_pst10mts: undefined,
        avg_wnd_dir_10m_pst10mts: undefined,
        avg_wnd_spd_10m_pst2mts: 3.3,
        avg_wnd_dir_10m_pst2mts: 313,
        avg_wnd_spd_10m_pst1mt: 3.4,
        avg_wnd_dir_10m_pst1mt: 301,
        max_wnd_spd_10m_pst1hr: 12.3,
      },
    },
  ],
};

/** A GeoMet WMS point reading, as returned for any raster layer. */
const wmsPoint = (value, klass) => ({
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Point', coordinates: [-123.2029, 49.3214] },
      properties: {
        value,
        class: klass,
        time: '2026-08-01T04:00:00Z',
        dim_reference_time: '2026-07-31T18:00:00Z',
      },
    },
  ],
});

/**
 * GeoMet answers an out-of-range TIME with an XML exception under HTTP 200,
 * not an error status.
 */
const WMS_XML_EXCEPTION =
  '<?xml version=\'1.0\' encoding="utf-8"?><ogc:ServiceExceptionReport ' +
  'version="1.3.0"><ogc:ServiceException code="InvalidDimensionValue">' +
  'Invalid time</ogc:ServiceException></ogc:ServiceExceptionReport>';

const SMOKE_BODY = wmsPoint(0, '< 1 [ug/m3]');

/** Route a mocked fetch by which ECCC surface the URL targets. */
function router(overrides = {}) {
  return (url) => {
    if (url.includes('/aqhi-stations/')) return { json: overrides.stations ?? AQHI_STATIONS_BODY };
    if (url.includes('/aqhi-observations-realtime/'))
      return { json: overrides.observations ?? AQHI_OBSERVATIONS_BODY };
    if (url.includes('/aqhi-forecasts-realtime/'))
      return { json: overrides.forecasts ?? AQHI_FORECASTS_BODY };
    if (url.includes('/swob-stations/'))
      return { json: overrides.swobStations ?? SWOB_STATIONS_BODY };
    if (url.includes('/swob-realtime/')) return { json: overrides.swobObs ?? SWOB_OBS_BODY };
    if (url.includes('/geomet')) return { json: overrides.smoke ?? SMOKE_BODY };
    if (url.includes('/citypageweather-realtime/items/'))
      return { json: overrides.site ?? SITE_BODY };
    return { json: overrides.sites ?? SITES_BODY };
  };
}

/** True for the second of the two hour stamps a 2-hour request produces. */
let firstHourSeen = '';
function seenSecondHour(url) {
  const time = new URL(url).searchParams.get('TIME');
  if (firstHourSeen === '') {
    firstHourSeen = time;
    return false;
  }
  return time !== firstHourSeen;
}

describe('eccc-weather MCP server', () => {
  it('lists the six tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'air_quality',
      'find_location',
      'forecast',
      'model_point',
      'observations',
      'wildfire_smoke',
    ]);
  });

  describe('find_location', () => {
    it('searches by name via full-text query', async () => {
      let requested = '';
      const result = await callTool(server, 'find_location', { name: 'West Vancouver' }, (url) => {
        requested = url;
        return { json: SITES_BODY };
      });
      expect(result.ok).toBe(true);
      expect(requested).toContain('api.weather.gc.ca');
      expect(requested).toContain('citypageweather-realtime');
      expect(requested).toContain('q=West+Vancouver');
      const s = result.result.structured;
      expect(s.count).toBe(2);
      expect(s.locations[0]).toMatchObject({
        siteId: 'bc-99',
        name: 'West Vancouver',
        region: 'Metro Vancouver',
        latitude: 49.33,
        longitude: -123.16,
      });
      // A name search has no reference point, so no distance is computed.
      expect(s.locations[0].distanceKm).toBeNull();
      expect(s.attribution).toContain('Environment and Climate Change Canada');
    });

    it('ranks by distance when given coordinates', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'find_location',
        { latitude: 49.3277, longitude: -123.1636 },
        (url) => {
          requested = url;
          return { json: SITES_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('bbox=');
      const s = result.result.structured;
      expect(s.locations[0].siteId).toBe('bc-99');
      // Ambleside sits essentially on the West Vancouver site.
      expect(s.locations[0].distanceKm).toBeLessThan(1);
      expect(s.locations[1].distanceKm).toBeGreaterThan(s.locations[0].distanceKm);
    });

    it('honours the count cap', async () => {
      const result = await callTool(
        server,
        'find_location',
        { name: 'Vancouver', count: 1 },
        {
          json: SITES_BODY,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.locations).toHaveLength(1);
    });

    it('reports no matches cleanly', async () => {
      const result = await callTool(
        server,
        'find_location',
        { name: 'Atlantis' },
        {
          json: { features: [] },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no environment canada forecast site/i);
    });

    it('rejects a call with neither name nor coordinates', async () => {
      const result = await callTool(server, 'find_location', {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/either name, or both latitude and longitude/i);
    });

    it('rejects an out-of-range latitude before fetching', async () => {
      const result = await callTool(server, 'find_location', { latitude: 100, longitude: 0 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'find_location',
        { name: 'Vancouver' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });

  describe('forecast', () => {
    it('returns current conditions, hourly rows, periods and sun times', async () => {
      let requested = '';
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, (url) => {
        requested = url;
        return { json: SITE_BODY };
      });
      expect(result.ok).toBe(true);
      expect(requested).toContain('/citypageweather-realtime/items/bc-99');
      const s = result.result.structured;
      expect(s.siteId).toBe('bc-99');
      expect(s.name).toBe('West Vancouver');
      expect(s.sunset).toBe('2026-08-02T03:53:00Z');
      expect(s.current).toMatchObject({
        temperature: 18.4,
        condition: 'Mainly Clear',
        // "calm" maps onto 0 km/h so callers can compare numerically.
        windSpeed: 0,
        windDirection: 'WNW',
        relativeHumidity: 62,
        dewpoint: 11.1,
      });
      expect(s.hourly).toHaveLength(2);
      expect(s.hourly[0]).toEqual({
        time: '2026-08-01T03:00:00Z',
        condition: 'Mainly sunny',
        temperature: 22,
        windSpeed: 5,
        windDirection: 'Variable direction',
        precipProbability: 0,
      });
      expect(s.hourly[1].windDirection).toBe('SW');
      expect(s.periods).toHaveLength(2);
      expect(s.periods[0]).toMatchObject({
        name: 'Tonight',
        summary: 'Clear. Low 16.',
        temperature: 16,
        temperatureClass: 'low',
        windSpeed: 15,
        windGust: 0,
        windDirection: 'SW',
      });
      // Periods carry no precipitation-probability field upstream.
      expect(s.periods[0]).not.toHaveProperty('precipProbability');
      expect(s.warnings).toEqual([]);
      expect(result.result.text).toContain('No active warnings');
      expect(result.result.text).toContain('Environment and Climate Change Canada');
    });

    it('caps hourly rows to the requested count', async () => {
      const result = await callTool(
        server,
        'forecast',
        { siteId: 'bc-99', hours: 1 },
        {
          json: SITE_BODY,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.hourly).toHaveLength(1);
    });

    it('survives a period with no wind entries', async () => {
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: SITE_BODY });
      expect(result.ok).toBe(true);
      const period = result.result.structured.periods[1];
      expect(period.name).toBe('Saturday');
      expect(period.windSpeed).toBeNull();
      expect(period.windGust).toBeNull();
      expect(period.windDirection).toBeNull();
    });

    it('surfaces active warnings', async () => {
      const withWarning = {
        ...SITE_BODY,
        properties: {
          ...SITE_BODY.properties,
          warnings: [
            {
              type: bi('warning'),
              description: bi('Heat warning in effect'),
              priority: bi('high'),
              url: bi('https://weather.gc.ca/warnings/'),
            },
          ],
        },
      };
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: withWarning });
      expect(result.ok).toBe(true);
      expect(result.result.structured.warnings[0]).toEqual({
        type: 'warning',
        description: 'Heat warning in effect',
        priority: 'high',
        url: 'https://weather.gc.ca/warnings/',
      });
      expect(result.result.text).toContain('Heat warning in effect');
    });

    it('omits the condition from the summary when ECCC does not publish one', async () => {
      const noCondition = {
        ...SITE_BODY,
        properties: {
          ...SITE_BODY.properties,
          currentConditions: { ...SITE_BODY.properties.currentConditions, condition: undefined },
        },
      };
      const result = await callTool(server, 'forecast', { siteId: 'bc-99' }, { json: noCondition });
      expect(result.ok).toBe(true);
      expect(result.result.structured.current.condition).toBeNull();
      expect(result.result.text).toContain('now 18.4°C');
      expect(result.result.text).not.toContain('now ?');
    });

    it('passes wind chill through when it is physically defined', async () => {
      // The summer suppression must not become a permanent null: at or below
      // freezing the value is real and has to survive.
      const below = await callTool(
        server,
        'forecast',
        { siteId: 'bc-99' },
        { json: siteAtTemperature(-8) },
      );
      expect(below.result.structured.current.windChill).toBe(-14);
      // Boundary: exactly 0 °C still counts as defined.
      const zero = await callTool(
        server,
        'forecast',
        { siteId: 'bc-99' },
        { json: siteAtTemperature(0) },
      );
      expect(zero.result.structured.current.windChill).toBe(-14);
      // Just above freezing is suppressed.
      const mild = await callTool(
        server,
        'forecast',
        { siteId: 'bc-99' },
        { json: siteAtTemperature(0.1) },
      );
      expect(mild.result.structured.current.windChill).toBeNull();
    });

    it('reads pressure in hPa whether the payload declares kPa or hPa', async () => {
      const kpa = await callTool(
        server,
        'forecast',
        { siteId: 'bc-99' },
        { json: siteWithPressure('kPa', 101.5) },
      );
      expect(kpa.result.structured.current.pressure).toBe(1015);
      const hpa = await callTool(
        server,
        'forecast',
        { siteId: 'bc-99' },
        { json: siteWithPressure('hPa', 1011.9) },
      );
      expect(hpa.result.structured.current.pressure).toBe(1011.9);
    });

    it('errors clearly when the site payload has no properties', async () => {
      const result = await callTool(server, 'forecast', { siteId: 'bc-999' }, { json: {} });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/find_location/i);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'forecast',
        { siteId: 'nope' },
        {
          status: 404,
          json: { description: 'item not found' },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('item not found');
    });

    it('rejects an empty siteId before fetching', async () => {
      const result = await callTool(server, 'forecast', { siteId: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('air_quality', () => {
    it('resolves the nearest zone and returns observation plus forecast', async () => {
      const seen = [];
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.3277, longitude: -123.1636 },
        (url) => {
          seen.push(url);
          return router()(url);
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.zoneId).toBe('JBRIK');
      expect(s.zoneName).toBe('Metro Vancouver - NW');
      expect(s.observed).toEqual({
        aqhi: 2.4,
        category: 'Low risk',
        time: '2026-08-01T02:00:00Z',
      });
      expect(s.forecast).toHaveLength(2);
      expect(s.forecast[0]).toEqual({
        time: hourStamp(0),
        aqhi: 2,
        category: 'Low risk',
      });
      // AQHI 8 sits in the high-risk band.
      expect(s.forecast[1].category).toBe('High risk');
      // The nearer of the two zones wins, and its id drives the follow-up calls.
      expect(seen.some((u) => u.includes('location_id=JBRIK'))).toBe(true);
      expect(seen.some((u) => u.includes('latest=true'))).toBe(true);
    });

    it('keeps only the newest publication run, ordered forward in time', async () => {
      let forecastUrl = '';
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.3277, longitude: -123.1636 },
        (url) => {
          if (url.includes('/aqhi-forecasts-realtime/')) forecastUrl = url;
          return router()(url);
        },
      );
      expect(result.ok).toBe(true);
      // ECCC serves several days of superseded runs; sorting by publication
      // date is what keeps a stale one from winning.
      expect(forecastUrl).toContain('sortby=-publication_datetime');
      const times = result.result.structured.forecast.map((f) => f.time);
      expect(times).toEqual([hourStamp(0), hourStamp(1)]);
      expect(times).not.toContain(hourStamp(-71));
    });

    it('drops forecast hours that have already elapsed', async () => {
      // A run covers hours before the moment it is read: the 00Z publication
      // still carries 00Z-03Z at 04Z. Asking for "the next hours" must not
      // return the past. Built around the real clock so it stays true.
      const stamp = hourStamp;
      const published = stamp(-4);
      const run = {
        features: [-4, -3, -2, -1, 0, 1, 2].map((offset) => ({
          properties: {
            publication_datetime: published,
            forecast_datetime: stamp(offset),
            aqhi: 3,
          },
        })),
      };
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.3277, longitude: -123.1636, hours: 3 },
        router({ forecasts: run }),
      );
      expect(result.ok).toBe(true);
      const times = result.result.structured.forecast.map((f) => f.time);
      expect(times).toEqual([stamp(0), stamp(1), stamp(2)]);
      expect(times.some((t) => t < stamp(0))).toBe(false);
    });

    it('falls back to a fully elapsed run rather than returning nothing', async () => {
      const stale = {
        features: [
          {
            properties: {
              publication_datetime: '2020-01-01T00:00:00Z',
              forecast_datetime: '2020-01-01T01:00:00Z',
              aqhi: 5,
            },
          },
        ],
      };
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.3277, longitude: -123.1636, hours: 3 },
        router({ forecasts: stale }),
      );
      expect(result.ok).toBe(true);
      // A stale publication is more useful than silence.
      expect(result.result.structured.forecast).toHaveLength(1);
    });

    it('reports no nearby zone cleanly', async () => {
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.3, longitude: -123.1 },
        router({ stations: { features: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.zoneId).toBeNull();
      expect(result.result.structured.forecast).toEqual([]);
      expect(result.result.text).toMatch(/no environment canada air quality zone/i);
    });

    it('nulls a missing observation without erroring', async () => {
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.3, longitude: -123.1 },
        router({ observations: { features: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.observed.aqhi).toBeNull();
      expect(result.result.structured.observed.category).toBe('Unknown');
    });

    it('rejects an out-of-range longitude before fetching', async () => {
      const result = await callTool(server, 'air_quality', { latitude: 0, longitude: 200 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('observations', () => {
    it('reports the nearest station and its latest reading', async () => {
      const seen = [];
      const result = await callTool(
        server,
        'observations',
        { latitude: 49.3277, longitude: -123.1636 },
        (url) => {
          seen.push(url);
          return router()(url);
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.stationName).toBe('POINT ATKINSON');
      expect(s.observedAt).toBe('2026-08-01T03:38:00.000Z');
      expect(s.airTemperature).toBe(21.5);
      expect(s.dewpoint).toBe(12);
      expect(s.relativeHumidity).toBe(55);
      expect(s.pressure).toBe(1011.9);
      expect(s.windGustMaxPastHour).toBe(12.3);
      expect(s.units.wind).toBe('km/h');
      // Nearest of the two stations wins, not the first listed.
      expect(s.distanceKm).toBeLessThan(10);
      expect(seen.some((u) => u.includes('swob-stations'))).toBe(true);
      expect(seen.some((u) => u.includes('swob-realtime'))).toBe(true);
    });

    it('falls back past a null wind window and names the one it used', async () => {
      const result = await callTool(
        server,
        'observations',
        { latitude: 49.3277, longitude: -123.1636 },
        router(),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      // The preferred 10-minute window is null in this record, so the
      // 2-minute mean is used — and the caller is told which.
      expect(s.windSpeed).toBe(3.3);
      expect(s.windDirection).toBe(313);
      expect(s.windAveragingWindow).toBe('2-minute average');
      expect(result.result.text).toContain('2-minute average');
    });

    it('reports no wind rather than guessing when every window is null', async () => {
      const result = await callTool(
        server,
        'observations',
        { latitude: 49.3277, longitude: -123.1636 },
        router({
          swobObs: {
            features: [
              { properties: { 'stn_nam-value': 'BARE', obs_date_tm: '2026-08-01T03:00:00.000Z' } },
            ],
          },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.windSpeed).toBeNull();
      expect(result.result.structured.windAveragingWindow).toBeNull();
      expect(result.result.text).toContain('wind not reported');
    });

    it('reports no nearby station cleanly', async () => {
      const result = await callTool(
        server,
        'observations',
        { latitude: 49.3, longitude: -123.1 },
        router({ swobStations: { features: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.stationName).toBeNull();
      expect(result.result.text).toMatch(/no environment canada surface station/i);
    });

    it('handles a station with no recent observation', async () => {
      const result = await callTool(
        server,
        'observations',
        { latitude: 49.3, longitude: -123.1 },
        router({ swobObs: { features: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.observedAt).toBeNull();
      expect(result.result.text).toMatch(/no recent observation/i);
    });

    it('rejects an out-of-range latitude before fetching', async () => {
      const result = await callTool(server, 'observations', { latitude: 91, longitude: 0 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('model_point', () => {
    it('reads an hourly grid and converts wind to km/h', async () => {
      const seen = [];
      const result = await callTool(
        server,
        'model_point',
        {
          latitude: 49.3277,
          longitude: -123.1636,
          variables: ['cloudCover', 'windSpeed'],
          hours: 2,
        },
        (url) => {
          seen.push(url);
          // 10 m/s of wind must surface as 36 km/h.
          if (url.includes('_WSPD')) return { json: wmsPoint(10, '15 - 20 kts') };
          return { json: wmsPoint(42, '40% cloud coverage') };
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.model).toContain('HRDPS');
      expect(s.referenceTime).toBe('2026-07-31T18:00:00Z');
      expect(s.units).toEqual({ cloudCover: '%', windSpeed: 'km/h' });
      expect(s.hours).toHaveLength(2);
      expect(s.hours[0].values.cloudCover).toBe(42);
      expect(s.hours[0].values.windSpeed).toBe(36);
      expect(s.missingHours).toBe(0);
      // One request per (variable x hour): 2 x 2.
      expect(seen).toHaveLength(4);
      expect(seen.every((u) => u.includes('TIME='))).toBe(true);
      expect(seen.some((u) => u.includes('HRDPS.CONTINENTAL_NT'))).toBe(true);
    });

    it('treats an XML exception as a missing hour, not a failure', async () => {
      const result = await callTool(
        server,
        'model_point',
        { latitude: 49.3277, longitude: -123.1636, variables: ['cloudCover'], hours: 2 },
        (url) => {
          // Second hour past the horizon: GeoMet answers 200 + XML.
          if (url.includes('TIME=') && seenSecondHour(url)) {
            return { text: WMS_XML_EXCEPTION, headers: { 'content-type': 'text/xml' } };
          }
          return { json: wmsPoint(42, '40% cloud coverage') };
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.missingHours).toBe(1);
      expect(result.result.text).toMatch(/past the ~48 h HRDPS horizon/i);
    });

    it('rejects a fan-out over the query cap before fetching', async () => {
      const result = await callTool(server, 'model_point', {
        latitude: 49.3277,
        longitude: -123.1636,
        variables: ['cloudCover', 'windSpeed', 'temperature'],
        hours: 24,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/72 model reads/);
    });

    it('surfaces a total upstream failure as retryable', async () => {
      const result = await callTool(
        server,
        'model_point',
        { latitude: 49.3277, longitude: -123.1636, variables: ['cloudCover'], hours: 2 },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('reports rate limiting distinctly from a missing hour', async () => {
      const result = await callTool(
        server,
        'model_point',
        { latitude: 49.3277, longitude: -123.1636, variables: ['cloudCover'], hours: 2 },
        { status: 429, text: '<html><title>429 Too Many Requests</title></html>' },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      // Must not read as "past the horizon" — that would be a silent lie.
      expect(result.error).toMatch(/rate-limited/i);
      expect(result.error).not.toMatch(/horizon/i);
    });

    it('rejects more than four variables before fetching', async () => {
      const result = await callTool(server, 'model_point', {
        latitude: 49.3277,
        longitude: -123.1636,
        variables: ['cloudCover', 'windSpeed', 'temperature', 'dewpoint', 'uvIndex'],
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('wildfire_smoke', () => {
    it('reads FireWork PM2.5 at a point', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'wildfire_smoke',
        { latitude: 49.3277, longitude: -123.1636 },
        (url) => {
          requested = url;
          return { json: SMOKE_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('geo.weather.gc.ca/geomet');
      expect(requested).toContain('REQUEST=GetFeatureInfo');
      expect(requested).toContain('RAQDPS.Sfc_PM2.5-WildfireSmokePlume');
      expect(result.result.structured).toEqual({
        latitude: 49.3277,
        longitude: -123.1636,
        pm25: 0,
        band: '< 1 [ug/m3]',
        time: '2026-08-01T04:00:00Z',
        model: 'FireWork (RAQDPS) 10 km',
        attribution: 'Data Source: Environment and Climate Change Canada',
      });
      expect(result.result.text).toContain('µg/m³');
    });

    it('reports an empty model response cleanly', async () => {
      const result = await callTool(
        server,
        'wildfire_smoke',
        { latitude: 49.3, longitude: -123.1 },
        { json: { features: [] } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.pm25).toBeNull();
      expect(result.result.text).toMatch(/no firework smoke data/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'wildfire_smoke',
        { latitude: 49.3, longitude: -123.1 },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('rejects an out-of-range latitude before fetching', async () => {
      const result = await callTool(server, 'wildfire_smoke', { latitude: -100, longitude: 0 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
