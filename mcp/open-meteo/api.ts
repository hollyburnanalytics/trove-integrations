import { ToolError } from '@ontrove/mcp';

/**
 * Open-Meteo API constants + response helpers: the per-surface host URLs, the
 * history-span cap, the WMO weather-code lookup table, and small decoders for
 * mapping non-2xx responses onto {@link ToolError} and reading parallel daily
 * arrays.
 */

/** Forecast + geocoding + air-quality hosts. */
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Max days a single historical query may span (keeps responses bounded). */
export const MAX_HISTORY_DAYS = 366;

/** WMO weather-interpretation codes → short text (Open-Meteo `weather_code`). */
const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

/** Describe a WMO weather code, falling back to the raw code. */
export function describeWeather(code: unknown): string {
  return typeof code === 'number' ? (WMO_CODES[code] ?? `Code ${code}`) : 'Unknown';
}

/**
 * Map an Open-Meteo non-2xx response, surfacing the API's own `reason` on a 400
 * (non-retryable bad params) and treating everything else as transient.
 */
export function openMeteoError(res: Response, body: string): ToolError {
  let reason = '';
  try {
    const j = JSON.parse(body) as { reason?: unknown };
    if (typeof j.reason === 'string') reason = j.reason;
  } catch {
    reason = body.slice(0, 120);
  }
  if (res.status === 400) {
    return new ToolError(`Open-Meteo rejected the request: ${reason || 'bad parameters'}.`, {
      retryable: false,
    });
  }
  return new ToolError('Open-Meteo is temporarily unavailable.', { retryable: true });
}

/** Read an index of a parallel daily array as a number, or null. */
export function numAt(arr: unknown, i: number): number | null {
  if (!Array.isArray(arr)) return null;
  const v = arr[i];
  return typeof v === 'number' ? v : null;
}
