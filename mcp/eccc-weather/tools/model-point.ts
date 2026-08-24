import { type ToolDefinition, ToolError, z } from '@ontrove/extend/toolkit';
import { ATTRIBUTION } from '../api.ts';
import {
  HRDPS_VARIABLES,
  MAX_POINT_QUERIES,
  mapWithConcurrency,
  parseWmsPoint,
  WMS_CONCURRENCY,
  wmsPointUrl,
} from '../wms.ts';

/**
 * `model_point` — hourly numeric HRDPS values at a coordinate.
 *
 * The City Page `forecast` tool is the human-readable product: 24 h of hourly
 * rows plus prose periods. This is the numeric one — the raw 2.5 km model
 * fields, including total cloud cover, which City Page publishes only as
 * condition text. Roughly a 48-hour horizon, refreshed every 6 hours.
 *
 * HRDPS is raster served over WMS, so there is no bulk endpoint: every
 * (variable × hour) pair is one `GetFeatureInfo` request. The request count is
 * therefore capped up front ({@link MAX_POINT_QUERIES}) and issued with bounded
 * concurrency. Hours past the model horizon come back as nulls rather than
 * failing the call, because GeoMet answers those with an XML exception under a
 * 200 status.
 */

/**
 * Why some hours came back empty: nothing when they all arrived, "outside the
 * domain" when none did, and the horizon otherwise.
 */
function horizonText(missingHours: number, totalHours: number, isOutsideDomain: boolean): string {
  if (missingHours === 0) return '';
  if (isOutsideDomain) {
    return (
      '\nNo data at this coordinate — HRDPS covers Canada and nearby waters, ' +
      'so this point is likely outside the model domain.'
    );
  }
  return (
    `\n${missingHours} of ${totalHours} hour(s) returned no data — past the ` +
    '~48 h HRDPS horizon.'
  );
}

/** The structured spelling of the same fact. */
function coverageOf(
  missingHours: number,
  isOutsideDomain: boolean,
): 'outsideDomain' | 'complete' | 'partial' {
  if (isOutsideDomain) return 'outsideDomain';
  return missingHours === 0 ? 'complete' : 'partial';
}

/** ISO hour stamps at `startHour`..`startHour + hours - 1` from a base time. */
function hourStamps(from: Date, startHour: number, hours: number): string[] {
  return Array.from({ length: hours }, (_unused, index) => {
    const at = new Date(from);
    at.setUTCMinutes(0, 0, 0);
    at.setUTCHours(at.getUTCHours() + startHour + index);
    return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  });
}

const VARIABLE_NAMES = Object.keys(HRDPS_VARIABLES) as [string, ...string[]];

export const modelPoint: ToolDefinition = {
  name: 'model_point',
  title: 'ECCC: Model point forecast (HRDPS)',
  description:
    "Hourly numeric weather at a coordinate from HRDPS, Environment Canada's " +
    '2.5 km high-resolution model — including total cloud cover, which the ' +
    'regular forecast tool only gives as condition text. Pick variables from: ' +
    `${VARIABLE_NAMES.join(', ')}. Horizon is about 48 hours; hours beyond it ` +
    'return null. Wind is converted to km/h. Canada only, times UTC.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    variables: z
      .array(z.enum(VARIABLE_NAMES))
      .min(1)
      .max(4)
      .default(['cloudCover', 'windSpeed'])
      .describe('Which HRDPS fields to read (1–4).'),
    startHour: z
      .number()
      .int()
      .min(0)
      .max(47)
      .default(0)
      .describe('Hours from now at which to start (0 = the current hour).'),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24)
      .default(6)
      .describe('How many consecutive hours to read (1–24).'),
  }),
  output: z.object({
    latitude: z.number(),
    longitude: z.number(),
    model: z.string(),
    referenceTime: z.string().nullable(),
    units: z.record(z.string(), z.string()),
    hours: z.array(
      z.object({
        time: z.string(),
        values: z.record(z.string(), z.number().nullable()),
      }),
    ),
    missingHours: z.number(),
    coverage: z.enum(['complete', 'partial', 'outsideDomain']),
    attribution: z.string(),
  }),
  async handler(args, ctx) {
    const { latitude, longitude, variables, startHour, hours } = args as {
      latitude: number;
      longitude: number;
      variables: string[];
      startHour: number;
      hours: number;
    };
    const selected = [...new Set(variables)];
    const requests = selected.length * hours;
    if (requests > MAX_POINT_QUERIES) {
      throw new ToolError(
        `That needs ${requests} model reads (${selected.length} variables × ${hours} hours), ` +
          `over the ${MAX_POINT_QUERIES} limit. Narrow the variables or the hour range.`,
        { retryable: false },
      );
    }

    const stamps = hourStamps(new Date(), startHour, hours);
    const cells = selected.flatMap((variable) => stamps.map((time) => ({ variable, time })));
    ctx.log('model_point', {
      latitude,
      longitude,
      variables: selected,
      startHour,
      hours,
      requests,
    });

    const readings = await mapWithConcurrency(cells, WMS_CONCURRENCY, async (cell) => {
      const spec = HRDPS_VARIABLES[cell.variable];
      if (spec === undefined) {
        return { ...cell, value: null, referenceTime: null, failed: true, rateLimited: false };
      }
      const response = await ctx.fetch(wmsPointUrl(spec.layer, latitude, longitude, cell.time));
      const body = await response.text();
      // One bad cell should not sink the whole grid — a request past the model
      // horizon is routine. Rate limiting and total wipeouts are caught below.
      if (!response.ok) {
        return {
          ...cell,
          value: null,
          referenceTime: null,
          failed: true,
          rateLimited: response.status === 429,
        };
      }
      const point = parseWmsPoint(body);
      const base = { ...cell, failed: false, rateLimited: false };
      if (point === null || point.value === null) {
        return { ...base, value: null, referenceTime: null };
      }
      const scaled = spec.scale === undefined ? point.value : point.value * spec.scale;
      return {
        ...base,
        value: Math.round(scaled * 100) / 100,
        referenceTime: point.referenceTime,
      };
    });

    // GeoMet rate-limits with a 429, and this tool is the one that fans out.
    // Left unhandled those cells become nulls indistinguishable from "past the
    // model horizon", so a throttled request is reported as exactly that.
    if (readings.some((reading) => reading.rateLimited)) {
      throw new ToolError(
        'Environment Canada rate-limited this request. Retry shortly, or ask for ' +
          'fewer variables or hours.',
        { retryable: true },
      );
    }
    // Every read erroring is an outage, not a horizon — say so retryably rather
    // than handing back a grid of silent nulls.
    if (readings.length > 0 && readings.every((reading) => reading.failed)) {
      throw new ToolError('Environment Canada is temporarily unavailable.', { retryable: true });
    }

    const units: Record<string, string> = {};
    for (const variable of selected) {
      const spec = HRDPS_VARIABLES[variable];
      if (spec !== undefined) units[variable] = spec.unit;
    }
    const referenceTime = readings.find((r) => r.referenceTime !== null)?.referenceTime ?? null;

    const rows = stamps.map((time) => {
      const values: Record<string, number | null> = {};
      for (const variable of selected) {
        values[variable] =
          readings.find((r) => r.time === time && r.variable === variable)?.value ?? null;
      }
      return { time, values };
    });
    const missingHours = rows.filter((row) =>
      selected.every((variable) => row.values[variable] === null),
    ).length;

    const lines = rows.map((row) => {
      const parts = selected.map(
        (variable) => `${variable} ${row.values[variable] ?? '?'}${units[variable] ?? ''}`,
      );
      return `  ${row.time}: ${parts.join(', ')}`;
    });
    // Two different causes produce identical nulls, and guessing wrong hands
    // the caller a confident falsehood. The first requested hour is always
    // inside the model horizon, so if even that is empty the coordinate is
    // outside the HRDPS domain; losing only later hours is the horizon.
    const isOutsideDomain = missingHours === rows.length;
    const horizonNote = horizonText(missingHours, rows.length, isOutsideDomain);
    return {
      text:
        `HRDPS 2.5 km at ${latitude},${longitude} (run ${referenceTime ?? 'unknown'}):\n` +
        `${lines.join('\n')}${horizonNote}\n\n${ATTRIBUTION}`,
      structured: {
        latitude,
        longitude,
        model: 'HRDPS Continental 2.5 km',
        referenceTime,
        units,
        hours: rows,
        missingHours,
        coverage: coverageOf(missingHours, isOutsideDomain),
        attribution: ATTRIBUTION,
      },
    };
  },
};
