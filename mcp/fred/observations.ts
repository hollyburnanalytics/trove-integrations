/**
 * `get_observations` — fetching, sizing and rendering FRED observation series.
 *
 * The governing rule here is that a response must never look complete when it
 * is not. FRED's `limit` silently clips the range, so every block carries
 * `availableInRange` (FRED's own pre-limit `count`), a `truncated` flag and a
 * `nextOffset`, and the prose says so in words. The second rule is that a
 * caller must be able to label what it got without a second tool call, so each
 * block carries the series' title, units, applied transform and seasonal
 * adjustment.
 */
import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError } from '@ontrove/extend/toolkit';
import {
  fetchSeriesMeta,
  frequencyConflict,
  getJson,
  parseValue,
  type SeriesMeta,
  seasonalPhrase,
} from './client.ts';

/** What each FRED `units` transform actually produces, for axis labelling. */
export const TRANSFORM_LABEL: Record<string, string> = {
  lin: 'levels',
  chg: 'change from previous period',
  ch1: 'change from year ago',
  pch: 'percent change from previous period',
  pc1: 'percent change from year ago',
  pca: 'percent change from previous period, annual rate',
  cch: 'continuously compounded percent change',
  cca: 'continuously compounded annual rate of change',
  log: 'natural log',
};

/** Validated arguments for one `get_observations` call. */
export interface ObservationArgs {
  seriesIds: string[];
  start?: string;
  end?: string;
  units: string;
  frequency?: string;
  aggregationMethod: string;
  limit: number;
  offset: number;
  sort: 'asc' | 'desc';
  format: 'pairs' | 'columnar';
}

/** One series' worth of result: descriptive metadata, sizing, and the data. */
export interface SeriesBlock {
  id: string;
  title: string | null;
  units: string | null;
  unitsTransform: string;
  unitsTransformLabel: string;
  frequency: string | null;
  /** The series' own frequency, kept visible when `frequency` aggregates it. */
  nativeFrequency: string | null;
  seasonalAdjustment: string | null;
  lastUpdated: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  returned: number;
  /** Total in range, or null when aggregation makes it genuinely unknowable. */
  availableInRange: number | null;
  truncated: boolean;
  nextOffset: number | null;
  observations?: { date: string; value: number | null }[];
  dates?: string[];
  values?: (number | null)[];
  note: string | null;
  /** Why this one series failed, when the others in the same call succeeded. */
  error: string | null;
}

/** Build the `/series/observations` query for one series id. */
function observationParams(seriesId: string, args: ObservationArgs): URLSearchParams {
  const params = new URLSearchParams({
    series_id: seriesId,
    // Under aggregation one extra row is requested: its presence is what tells
    // us more exists, because FRED's `count` can't (see `sizing`).
    limit: String(args.frequency ? args.limit + 1 : args.limit),
    offset: String(args.offset),
    sort_order: args.sort,
    units: args.units,
  });
  if (args.start) params.set('observation_start', args.start);
  if (args.end) params.set('observation_end', args.end);
  if (args.frequency) {
    params.set('frequency', args.frequency);
    params.set('aggregation_method', args.aggregationMethod);
  }
  return params;
}

/** Describe an empty result in terms of what the series actually covers. */
function emptyNote(seriesId: string, meta: SeriesMeta | null, args: ObservationArgs): string {
  const bounds = [args.start ?? 'series start', args.end ?? 'series end'].join(' → ');
  if (meta?.observationStart && meta.observationEnd) {
    return (
      `No observations in ${bounds}; ${seriesId} covers ` +
      `${meta.observationStart} to ${meta.observationEnd}.`
    );
  }
  return `No observations for ${seriesId} in ${bounds}.`;
}

/** One observation row as returned by FRED, with "." already mapped to null. */
type Row = { date: string; value: number | null };

/** Map FRED's raw `observations` array into typed rows. */
function parseRows(body: Record<string, unknown>): Row[] {
  const raw = Array.isArray(body.observations) ? body.observations : [];
  return raw.map((o) => {
    const rec = o as Record<string, unknown>;
    return {
      date: typeof rec.date === 'string' ? rec.date : '',
      value: parseValue(rec.value),
    };
  });
}

/** The descriptive half of a block — what the numbers are, so they can be labelled. */
function describe(seriesId: string, meta: SeriesMeta | null, args: ObservationArgs) {
  return {
    id: seriesId,
    title: meta?.title ?? null,
    units: meta?.units ?? null,
    unitsTransform: args.units,
    unitsTransformLabel: TRANSFORM_LABEL[args.units] ?? args.units,
    frequency: args.frequency
      ? `${args.frequency} (${args.aggregationMethod})`
      : (meta?.frequency ?? null),
    // Aggregation replaces `frequency`, so the series' own cadence is kept
    // separately — otherwise a daily series resampled annually is
    // indistinguishable from one that was annual to begin with.
    nativeFrequency: meta?.frequency ?? null,
    seasonalAdjustment: meta?.seasonalAdjustment ?? null,
    lastUpdated: meta?.lastUpdated ?? null,
    coverageStart: meta?.observationStart ?? null,
    coverageEnd: meta?.observationEnd ?? null,
  };
}

/** How much of the range this page covers, and whether more of it exists. */
interface Sizing {
  rows: Row[];
  returned: number;
  availableInRange: number | null;
  truncated: boolean;
  nextOffset: number | null;
}

/**
 * Decide the sizing fields — the ones a caller trusts to know whether it has
 * the whole answer, so they must never be confidently wrong.
 *
 * Without `frequency`, FRED's top-level `count` is the true size of the
 * matching set before limit/offset, and is used directly.
 *
 * With `frequency` it is NOT. FRED reports the **un-aggregated** row count
 * unless the whole aggregated set fit strictly inside `limit`: five years of
 * daily DGS10 asked for monthly at `limit=10` answers `count: 1305`, not 60 —
 * and at `limit=60` (exactly the aggregated size) it still answers 1305. So it
 * is wrong precisely when the result is truncated, which is the only case the
 * field exists for. Under aggregation it is therefore ignored: one extra row is
 * requested, its presence is what says more exists, and the total is reported
 * as unknown rather than guessed at.
 */
function sizing(all: Row[], body: Record<string, unknown>, args: ObservationArgs): Sizing {
  if (args.frequency) {
    const isMore = all.length > args.limit;
    const rows = isMore ? all.slice(0, args.limit) : all;
    return {
      rows,
      returned: rows.length,
      availableInRange: isMore ? null : args.offset + rows.length,
      truncated: isMore,
      nextOffset: isMore ? args.offset + rows.length : null,
    };
  }
  const returned = all.length;
  const available = typeof body.count === 'number' ? body.count : args.offset + returned;
  const isTruncated = args.offset + returned < available;
  return {
    rows: all,
    returned,
    availableInRange: available,
    truncated: isTruncated,
    // Only advertise a next page when this one actually moved forward, so a
    // caller looping on `nextOffset` cannot spin on an out-of-range offset.
    nextOffset: isTruncated && returned > 0 ? args.offset + returned : null,
  };
}

/** Fetch and shape one series. `meta` is pre-fetched so frequency can be vetted. */
async function fetchOne(
  seriesId: string,
  meta: SeriesMeta | null,
  args: ObservationArgs,
  ctx: ToolContext,
): Promise<SeriesBlock> {
  const body = await getJson('/series/observations', observationParams(seriesId, args), ctx);
  const { rows, ...size } = sizing(parseRows(body), body, args);
  // Columnar lists dates rather than deriving them from start+frequency: FRED's
  // "Daily" series are business-daily (no weekend rows), so a derived axis would
  // silently mislabel every point after the first weekend.
  const data =
    args.format === 'columnar'
      ? { dates: rows.map((r) => r.date), values: rows.map((r) => r.value) }
      : { observations: rows };
  return {
    ...describe(seriesId, meta, args),
    ...size,
    ...data,
    note: size.returned === 0 ? emptyNote(seriesId, meta, args) : null,
    error: null,
  };
}

/** A placeholder block for a series that failed while its siblings succeeded. */
function failedBlock(
  seriesId: string,
  meta: SeriesMeta | null,
  args: ObservationArgs,
  message: string,
): SeriesBlock {
  return {
    ...describe(seriesId, meta, args),
    returned: 0,
    availableInRange: null,
    truncated: false,
    nextOffset: null,
    ...(args.format === 'columnar' ? { dates: [], values: [] } : { observations: [] }),
    note: null,
    error: message,
  };
}

/** The descriptive header line(s) for one series in the prose rendering. */
function renderHeader(block: SeriesBlock): string[] {
  const facts = [
    block.units,
    block.frequency,
    seasonalPhrase(block.seasonalAdjustment),
    block.unitsTransform === 'lin'
      ? null
      : `transform ${block.unitsTransform} — ${block.unitsTransformLabel}`,
  ].filter(Boolean);
  return [`${block.id} — ${block.title ?? '(title unavailable)'}`, `  ${facts.join(' · ')}`];
}

/** Render one series block: header, sizing/truncation state, then a preview. */
function renderBlock(block: SeriesBlock, args: ObservationArgs, previewRows: number): string {
  const lines = renderHeader(block);
  if (block.error) {
    lines.push(`  FAILED: ${block.error}`);
    return lines.join('\n');
  }
  if (block.note) {
    lines.push(`  ${block.note}`);
    return lines.join('\n');
  }
  const dates = block.dates ?? block.observations?.map((o) => o.date) ?? [];
  const values = block.values ?? block.observations?.map((o) => o.value) ?? [];
  const span = dates.length > 0 ? ` (${dates[0]} → ${dates.at(-1)})` : '';
  const total = block.availableInRange;
  if (!block.truncated) {
    lines.push(`  ${block.returned} observation(s) in range${span} — complete.`);
  } else if (total === null) {
    // Aggregated: FRED can't tell us the aggregated total, so don't invent one.
    lines.push(
      `  TRUNCATED: ${block.returned} observation(s)${span}, and more exist — the aggregated ` +
        `total in range is not reported by FRED. Re-call with offset=${block.nextOffset}, ` +
        'or raise limit to pull the rest in one page.',
    );
  } else {
    lines.push(
      `  TRUNCATED: ${block.returned} of ${total} observations in range${span}. ` +
        `${total - args.offset - block.returned} more not returned — re-call with ` +
        `offset=${block.nextOffset}, or set frequency to aggregate instead of paginating.`,
    );
  }
  for (const [i, date] of dates.slice(0, previewRows).entries()) {
    lines.push(`  ${date}: ${values[i] ?? 'n/a'}`);
  }
  if (dates.length > previewRows) lines.push(`  … ${dates.length - previewRows} more in the data`);
  return lines.join('\n');
}

/**
 * Run one `get_observations` call across 1–5 series.
 *
 * Metadata is fetched first for every id, in parallel, because it is needed
 * both to label the result and to reject an impossible `frequency` by name
 * before any observation request is made.
 */
export async function runObservations(args: ObservationArgs, ctx: ToolContext) {
  const metas = await Promise.all(args.seriesIds.map((id) => fetchSeriesMeta(id, ctx)));
  if (args.frequency) {
    const conflicts = metas.map((m) => frequencyConflict(m, args.frequency ?? '')).filter(Boolean);
    if (conflicts.length > 0) throw new ToolError(conflicts.join(' '), { retryable: false });
  }
  // One bad id must not discard four good series. Each series is isolated; a
  // failure becomes a block carrying its reason. Only a call where EVERY series
  // failed throws, so a single-id call still errors exactly as it used to.
  const thrown: unknown[] = Array.from({ length: args.seriesIds.length });
  const blocks = await Promise.all(
    args.seriesIds.map(async (id, i) => {
      try {
        return await fetchOne(id, metas[i] ?? null, args, ctx);
      } catch (error) {
        thrown[i] = error;
        const message = error instanceof ToolError ? error.message : `${id} could not be fetched.`;
        ctx.log('series failed', { id, message });
        return failedBlock(id, metas[i] ?? null, args, message);
      }
    }),
  );
  // Rethrow the original rather than a summary, so the SDK's retryability and
  // error code survive — a 500 on the only requested series is still retryable.
  if (blocks.every((b) => b.error)) throw thrown.find((e) => e !== undefined);
  const previewRows = blocks.length > 1 ? 6 : 12;
  const text = blocks.map((b) => renderBlock(b, args, previewRows)).join('\n\n');
  return {
    text,
    structured: {
      seriesCount: blocks.length,
      unitsTransform: args.units,
      format: args.format,
      series: blocks,
    },
  };
}
