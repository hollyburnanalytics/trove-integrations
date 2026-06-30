import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const GEOCODE_BODY = {
  results: [
    {
      name: 'Vancouver',
      latitude: 49.25,
      longitude: -123.11,
      country: 'Canada',
      admin1: 'British Columbia',
      timezone: 'America/Vancouver',
      population: 600_000,
    },
    {
      name: 'Vancouver',
      latitude: 45.63,
      longitude: -122.66,
      country: 'United States',
      admin1: 'Washington',
      timezone: 'America/Los_Angeles',
      population: 190_000,
    },
  ],
};

const FORECAST_BODY = {
  timezone: 'America/Vancouver',
  current: { temperature_2m: 18.4, weather_code: 1, wind_speed_10m: 12.3 },
  daily: {
    time: ['2026-06-27', '2026-06-28'],
    temperature_2m_max: [22.1, 23.4],
    temperature_2m_min: [13.2, 14],
    precipitation_sum: [0, 1.5],
    weather_code: [1, 61],
  },
};

const AIR_QUALITY_BODY = {
  current: { us_aqi: 42, pm2_5: 8.1, pm10: 14.2 },
};

const HISTORICAL_BODY = {
  daily: {
    time: ['2025-01-01', '2025-01-02'],
    temperature_2m_max: [5.1, 6.2],
    temperature_2m_min: [1, 2],
    precipitation_sum: [2, 0],
  },
};

describe('open-meteo MCP server', () => {
  it('lists the four tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'air_quality',
      'forecast',
      'geocode_place',
      'historical',
    ]);
  });

  describe('geocode_place', () => {
    it('returns ranked place matches', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'geocode_place',
        { name: 'Vancouver', count: 2 },
        (url) => {
          requested = url;
          return { json: GEOCODE_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('geocoding-api.open-meteo.com');
      expect(requested).toContain('name=Vancouver');
      expect(requested).toContain('count=2');
      expect(result.result.structured.query).toBe('Vancouver');
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.places[0]).toMatchObject({
        name: 'Vancouver',
        latitude: 49.25,
        longitude: -123.11,
        country: 'Canada',
        admin1: 'British Columbia',
      });
      expect(result.result.text).toContain('British Columbia');
    });

    it('reports no matches cleanly', async () => {
      const result = await callTool(
        server,
        'geocode_place',
        { name: 'Nowheresville' },
        { json: {} },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.places).toEqual([]);
      expect(result.result.text).toMatch(/no places/i);
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'geocode_place',
        { name: 'Vancouver' },
        { status: 400, json: { reason: 'Parameter name is invalid' } },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('Parameter name is invalid');
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'geocode_place',
        { name: 'Vancouver' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects count above the max before fetching', async () => {
      const result = await callTool(server, 'geocode_place', { name: 'Vancouver', count: 11 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty name before fetching', async () => {
      const result = await callTool(server, 'geocode_place', { name: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('forecast', () => {
    it('returns current conditions and a daily forecast', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'forecast',
        { latitude: 49.25, longitude: -123.11, days: 2 },
        (url) => {
          requested = url;
          return { json: FORECAST_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('api.open-meteo.com/v1/forecast');
      expect(requested).toContain('forecast_days=2');
      const s = result.result.structured;
      expect(s.timezone).toBe('America/Vancouver');
      expect(s.units).toEqual({ temperature: '°C', wind: 'km/h', precipitation: 'mm' });
      expect(s.current).toEqual({ temperature: 18.4, weather: 'Mainly clear', windSpeed: 12.3 });
      expect(s.daily).toHaveLength(2);
      expect(s.daily[0]).toEqual({
        date: '2026-06-27',
        temperatureMax: 22.1,
        temperatureMin: 13.2,
        precipitation: 0,
        weather: 'Mainly clear',
      });
      expect(s.daily[1].weather).toBe('Slight rain');
      expect(result.result.text).toContain('Mainly clear');
    });

    it('switches units and request params to imperial', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'forecast',
        { latitude: 49.25, longitude: -123.11, days: 1, units: 'imperial' },
        (url) => {
          requested = url;
          return { json: FORECAST_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('temperature_unit=fahrenheit');
      expect(requested).toContain('wind_speed_unit=mph');
      expect(result.result.structured.units).toEqual({
        temperature: '°F',
        wind: 'mph',
        precipitation: 'in',
      });
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'forecast',
        { latitude: 49.25, longitude: -123.11 },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an out-of-range latitude before fetching', async () => {
      const result = await callTool(server, 'forecast', { latitude: 100, longitude: 0 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('air_quality', () => {
    it('returns current AQI and particulate levels', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.25, longitude: -123.11 },
        (url) => {
          requested = url;
          return { json: AIR_QUALITY_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('air-quality-api.open-meteo.com');
      expect(result.result.structured).toEqual({
        latitude: 49.25,
        longitude: -123.11,
        usAqi: 42,
        pm2_5: 8.1,
        pm10: 14.2,
      });
      expect(result.result.text).toContain('US AQI 42');
    });

    it('nulls missing fields without erroring', async () => {
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.25, longitude: -123.11 },
        { json: { current: {} } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.usAqi).toBeNull();
      expect(result.result.structured.pm2_5).toBeNull();
    });

    it('maps a 400 to a non-retryable tool error', async () => {
      const result = await callTool(
        server,
        'air_quality',
        { latitude: 49.25, longitude: -123.11 },
        { status: 400, json: { reason: 'bad coords' } },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects an out-of-range longitude before fetching', async () => {
      const result = await callTool(server, 'air_quality', { latitude: 0, longitude: 200 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('historical', () => {
    it('returns daily archive rows and a range summary', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'historical',
        {
          latitude: 49.25,
          longitude: -123.11,
          startDate: '2025-01-01',
          endDate: '2025-01-02',
        },
        (url) => {
          requested = url;
          return { json: HISTORICAL_BODY };
        },
      );
      expect(result.ok).toBe(true);
      expect(requested).toContain('archive-api.open-meteo.com');
      expect(requested).toContain('start_date=2025-01-01');
      expect(requested).toContain('end_date=2025-01-02');
      const s = result.result.structured;
      expect(s.units).toEqual({ temperature: '°C', precipitation: 'mm' });
      expect(s.summary).toEqual({
        days: 2,
        meanTemperatureMax: 5.7,
        meanTemperatureMin: 1.5,
        totalPrecipitation: 2,
      });
      expect(s.daily).toHaveLength(2);
      expect(s.daily[0]).toEqual({
        date: '2025-01-01',
        temperatureMax: 5.1,
        temperatureMin: 1,
        precipitation: 2,
      });
      expect(result.result.text).toContain('mean high 5.7');
    });

    it('reports an empty archive cleanly', async () => {
      const result = await callTool(
        server,
        'historical',
        {
          latitude: 49.25,
          longitude: -123.11,
          startDate: '2025-01-01',
          endDate: '2025-01-02',
        },
        { json: { daily: { time: [] } } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.summary.days).toBe(0);
      expect(result.result.text).toMatch(/no historical data/i);
    });

    it('rejects an end date before the start date (no fetch)', async () => {
      const result = await callTool(server, 'historical', {
        latitude: 49.25,
        longitude: -123.11,
        startDate: '2025-02-01',
        endDate: '2025-01-01',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/on or after/i);
    });

    it('rejects a range longer than 366 days (no fetch)', async () => {
      const result = await callTool(server, 'historical', {
        latitude: 49.25,
        longitude: -123.11,
        startDate: '2020-01-01',
        endDate: '2025-01-01',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/range too long/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'historical',
        {
          latitude: 49.25,
          longitude: -123.11,
          startDate: '2025-01-01',
          endDate: '2025-01-02',
        },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a malformed start date before fetching', async () => {
      const result = await callTool(server, 'historical', {
        latitude: 49.25,
        longitude: -123.11,
        startDate: '01-01-2025',
        endDate: '2025-01-02',
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
