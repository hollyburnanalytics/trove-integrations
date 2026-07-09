import { z } from '@ontrove/mcp';

/**
 * Shared row-field readers, amount formatting, and reusable zod input schemas
 * for the jonas-premier tool modules. Premier omits or nulls fields freely and
 * returns some booleans as strings, so every tool maps rows through these
 * lenient accessors rather than reading properties directly.
 */

/** Read a string prop, or null (Premier omits/nulls fields freely). */
export const str = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key];
  return typeof v === 'string' && v !== '' ? v : null;
};

/** Read a finite number prop, or null. */
export const num = (row: Record<string, unknown>, key: string): number | null => {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** Read a boolean-ish prop (GL fields arrive as "True"/"False" strings), or null. */
export const boolish = (row: Record<string, unknown>, key: string): boolean | null => {
  const v = row[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
};

/** Sum a mapped numeric field, ignoring nulls. */
export const sum = (rows: { [k: string]: unknown }[], key: string): number =>
  rows.reduce((acc, r) => acc + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);

/** Format an amount for the text summary (ledger currency, 2 dp). */
export const fmt = (n: number | null): string =>
  n === null
    ? '?'
    : n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An ISO date or datetime, e.g. "2026-01-31" or "2026-01-31T00:00:00". */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use ISO format, e.g. 2026-01-31 or 2026-01-31T00:00:00');

/** Shared pagination inputs (Premier caps pageSize at 1000). */
export const pageInput = {
  page: z.number().int().min(1).default(1).describe('Page number (default 1).'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(50)
    .describe('Records per page (1–1000, default 50).'),
};

export const uuid = (label: string) => z.string().min(1).describe(label);
