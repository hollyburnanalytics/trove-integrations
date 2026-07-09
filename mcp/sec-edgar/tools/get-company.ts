import { type ToolDefinition, z } from '@ontrove/mcp';
import { type Company, edgarJson, requireCompany, submissionsUrl } from '../client.ts';
import { JURISDICTIONS } from '../jurisdictions.ts';

/**
 * `get_company` — the SEC's registrant profile for one entity.
 */

/** The structured registrant profile returned by `get_company`. */
interface CompanyProfile {
  company: string;
  cik: string;
  tickers: string[];
  exchanges: string[];
  sic: string | null;
  sicDescription: string | null;
  entityType: string | null;
  category: string | null;
  stateOfIncorporation: string | null;
  stateOfIncorporationLabel: string | null;
  fiscalYearEnd: string | null;
  website: string | null;
  phone: string | null;
  formerNames: { name: string; from: string; to: string }[];
}

/** Extract the structured registrant profile from an EDGAR submissions body. */
function parseCompanyProfile(body: Record<string, unknown>, resolved: Company): CompanyProfile {
  const str = (key: string): string | null =>
    typeof body[key] === 'string' && body[key] ? (body[key] as string) : null;
  const strings = (key: string): string[] =>
    Array.isArray(body[key]) ? (body[key] as unknown[]).filter((v) => typeof v === 'string') : [];
  const formerNames = (Array.isArray(body.formerNames) ? body.formerNames : [])
    .map((raw) => {
      const item = raw as { name?: unknown; from?: unknown; to?: unknown };
      if (typeof item.name !== 'string') return null;
      return {
        name: item.name,
        from: typeof item.from === 'string' ? item.from.slice(0, 10) : '',
        to: typeof item.to === 'string' ? item.to.slice(0, 10) : '',
      };
    })
    .filter((item): item is { name: string; from: string; to: string } => item !== null);
  // fiscalYearEnd arrives as "MMDD" — render as MM-DD.
  const fye = str('fiscalYearEnd');
  const fiscalYearEnd = fye && /^\d{4}$/.test(fye) ? `${fye.slice(0, 2)}-${fye.slice(2)}` : fye;
  const stateCode = str('stateOfIncorporation');

  return {
    company: str('name') ?? resolved.name,
    cik: resolved.cik,
    tickers: strings('tickers'),
    exchanges: strings('exchanges'),
    sic: str('sic'),
    sicDescription: str('sicDescription'),
    entityType: str('entityType'),
    category: str('category'),
    stateOfIncorporation: stateCode,
    stateOfIncorporationLabel: stateCode === null ? null : (JURISDICTIONS[stateCode] ?? null),
    fiscalYearEnd,
    website: str('website'),
    phone: str('phone'),
    formerNames,
  };
}

/** Render the human-readable profile summary (one fact per line). */
function formatCompanyProfile(p: CompanyProfile): string {
  const stateCode = p.stateOfIncorporation;
  const stateLabel = p.stateOfIncorporationLabel;
  const parts = [
    `${p.company} (CIK ${p.cik})`,
    p.tickers.length > 0
      ? `Listed: ${p.tickers.map((t, i) => `${t}${p.exchanges[i] ? ` (${p.exchanges[i]})` : ''}`).join(', ')}`
      : 'No listed tickers',
    p.sicDescription ? `Industry: ${p.sicDescription} (SIC ${p.sic})` : null,
    p.entityType ? `Entity type: ${p.entityType}` : null,
    p.category ? `Filer category: ${p.category}` : null,
    stateCode
      ? `Incorporated: ${stateLabel ?? stateCode}${stateLabel ? ` (${stateCode})` : ''}`
      : null,
    p.fiscalYearEnd ? `Fiscal year ends: ${p.fiscalYearEnd}` : null,
    p.website ? `Website: ${p.website}` : null,
    p.formerNames.length > 0
      ? `Former names: ${p.formerNames.map((f) => `${f.name} (${f.from} → ${f.to})`).join('; ')}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.join('\n');
}

export const getCompany: ToolDefinition = {
  name: 'get_company',
  title: 'EDGAR: Company profile',
  description:
    "The SEC's registrant profile for a company: legal name, CIK, tickers and " +
    'exchanges, SIC industry classification, entity type and filer category, state ' +
    'of incorporation, fiscal-year end, website/phone, and former names. Useful to ' +
    'confirm you have the right entity before pulling financials or filings.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z.string().min(1).describe('Ticker, company name, or CIK.'),
  }),
  output: z.object({
    company: z.string(),
    cik: z.string(),
    tickers: z.array(z.string()),
    exchanges: z.array(z.string()),
    sic: z.string().nullable(),
    sicDescription: z.string().nullable(),
    entityType: z.string().nullable(),
    category: z.string().nullable(),
    stateOfIncorporation: z.string().nullable(),
    stateOfIncorporationLabel: z.string().nullable(),
    fiscalYearEnd: z.string().nullable(),
    website: z.string().nullable(),
    phone: z.string().nullable(),
    formerNames: z.array(z.object({ name: z.string(), from: z.string(), to: z.string() })),
  }),
  async handler(args, ctx) {
    ctx.log('get_company', { company: args.company });
    const resolved = await requireCompany(ctx, args.company);
    const body = await edgarJson(
      ctx,
      submissionsUrl(resolved.cik),
      `SEC EDGAR has no record for CIK ${resolved.cik}.`,
    );
    const profile = parseCompanyProfile(body, resolved);
    return { text: formatCompanyProfile(profile), structured: profile };
  },
};
