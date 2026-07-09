import type { ToolContext } from '@ontrove/mcp';
import { edgarJson, submissionsUrl } from './client.ts';

/**
 * A company's submissions feed: the parallel-array `recent` block, the dated
 * older-history archives, and the 8-K item-code decoding — shared by every
 * tool that walks a filing list.
 */

export interface RecentFiling {
  form: string;
  filedDate: string;
  accession: string;
  primaryDocument: string | null;
  description: string | null;
  items: string | null;
  reportDate: string | null;
}

/** A pointer to one of the older-history submission archives. */
export interface ArchiveRef {
  name: string;
  from: string;
  to: string;
}

/** Flatten one parallel-array filing block (`filings.recent` or an archive file). */
function flattenFilingBlock(block: Record<string, unknown> | undefined): RecentFiling[] {
  const column = (key: string): unknown[] => (Array.isArray(block?.[key]) ? block[key] : []);
  const str = (row: unknown): string | null => (typeof row === 'string' && row ? row : null);
  const forms = column('form');
  const dates = column('filingDate');
  const accessions = column('accessionNumber');
  const docs = column('primaryDocument');
  const descriptions = column('primaryDocDescription');
  const items = column('items');
  const reportDates = column('reportDate');
  return forms.map((form, i) => ({
    form: typeof form === 'string' ? form : '?',
    filedDate: str(dates[i]) ?? '?',
    accession: str(accessions[i]) ?? '',
    primaryDocument: str(docs[i]),
    description: str(descriptions[i]),
    items: str(items[i]),
    reportDate: str(reportDates[i]),
  }));
}

/** Fetch a company's submissions: recent filings + pointers to older archives. */
export async function recentFilings(
  ctx: ToolContext,
  cik: string,
): Promise<{ name: string; filings: RecentFiling[]; archives: ArchiveRef[] }> {
  const body = await edgarJson(
    ctx,
    submissionsUrl(cik),
    `SEC EDGAR has no filings record for CIK ${cik}.`,
  );
  const name = typeof body.name === 'string' ? body.name : '';
  const filingsBlock = (body.filings ?? {}) as Record<string, unknown>;
  const filings = flattenFilingBlock(filingsBlock.recent as Record<string, unknown> | undefined);
  const archives: ArchiveRef[] = [];
  for (const raw of Array.isArray(filingsBlock.files) ? filingsBlock.files : []) {
    const file = raw as { name?: unknown; filingFrom?: unknown; filingTo?: unknown };
    if (typeof file.name !== 'string') continue;
    archives.push({
      name: file.name,
      from: typeof file.filingFrom === 'string' ? file.filingFrom : '0000-00-00',
      to: typeof file.filingTo === 'string' ? file.filingTo : '9999-99-99',
    });
  }
  return { name, filings, archives };
}

/**
 * Extend a filing pool with older-history archives until the caller's filter
 * is satisfied or the relevant archives are exhausted. The submissions
 * `recent` block covers only the newest ~1,000 filings; long filers keep the
 * rest in dated archive files. At most 4 archives are fetched per call.
 */
export async function withArchivedFilings(
  ctx: ToolContext,
  base: RecentFiling[],
  archives: ArchiveRef[],
  matches: (filing: RecentFiling) => boolean,
  limit: number,
  startDate?: string,
  endDate?: string,
): Promise<{ pool: RecentFiling[]; historyComplete: boolean }> {
  const relevant = archives
    .filter((a) => (!startDate || a.to >= startDate) && (!endDate || a.from <= endDate))
    .sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
  let pool = base;
  let used = 0;
  for (const archive of relevant) {
    if (pool.filter(matches).length >= limit || used >= 4) break;
    used += 1;
    const block = await edgarJson(
      ctx,
      `https://data.sec.gov/submissions/${archive.name}`,
      'An SEC EDGAR history archive is unavailable; try again shortly.',
    );
    pool = [...pool, ...flattenFilingBlock(block)];
  }
  return { pool, historyComplete: used >= relevant.length };
}

/** 8-K item codes → plain-English event labels (fixed SEC definitions). */
const ITEM_LABELS: Record<string, string> = {
  '1.01': 'Material agreement',
  '1.02': 'Termination of material agreement',
  '1.03': 'Bankruptcy or receivership',
  '1.05': 'Material cybersecurity incident',
  '2.01': 'Acquisition or disposition of assets',
  '2.02': 'Results of operations (earnings)',
  '2.03': 'New direct financial obligation',
  '2.04': 'Triggering event on financial obligation',
  '2.05': 'Exit or disposal costs',
  '2.06': 'Material impairments',
  '3.01': 'Delisting or listing-rule noncompliance',
  '3.02': 'Unregistered equity sales',
  '3.03': 'Modification to security-holder rights',
  '4.01': 'Change of auditor',
  '4.02': 'Non-reliance on prior financials (restatement)',
  '5.01': 'Change in control',
  '5.02': 'Officer/director departure, election, or compensation',
  '5.03': 'Charter/bylaw amendment or fiscal-year change',
  '5.07': 'Shareholder vote results',
  '5.08': 'Shareholder director nominations',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'Other events',
  '9.01': 'Financial statements and exhibits',
};

/** "2.02,9.01" → "2.02 Results of operations (earnings); 9.01 …". */
export function decodeItems(items: string | null): string | null {
  if (!items) return null;
  const parts = items
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => (ITEM_LABELS[code] ? `${code} ${ITEM_LABELS[code]}` : code));
  return parts.length > 0 ? parts.join('; ') : null;
}
