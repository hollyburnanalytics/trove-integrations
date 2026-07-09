import { type ToolDefinition, z } from '@ontrove/mcp';
import { edgarJson, requireCompany, submissionsUrl } from '../client.ts';
import { JURISDICTIONS } from '../jurisdictions.ts';

/**
 * `get_company` — the SEC's registrant profile for one entity.
 */

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
    const name = str('name') ?? resolved.name;
    const tickers = strings('tickers');
    const exchanges = strings('exchanges');
    const stateCode = str('stateOfIncorporation');
    const stateLabel = stateCode === null ? null : (JURISDICTIONS[stateCode] ?? null);

    const parts = [
      `${name} (CIK ${resolved.cik})`,
      tickers.length > 0
        ? `Listed: ${tickers.map((t, i) => `${t}${exchanges[i] ? ` (${exchanges[i]})` : ''}`).join(', ')}`
        : 'No listed tickers',
      str('sicDescription') ? `Industry: ${str('sicDescription')} (SIC ${str('sic')})` : null,
      str('entityType') ? `Entity type: ${str('entityType')}` : null,
      str('category') ? `Filer category: ${str('category')}` : null,
      stateCode
        ? `Incorporated: ${stateLabel ?? stateCode}${stateLabel ? ` (${stateCode})` : ''}`
        : null,
      fiscalYearEnd ? `Fiscal year ends: ${fiscalYearEnd}` : null,
      str('website') ? `Website: ${str('website')}` : null,
      formerNames.length > 0
        ? `Former names: ${formerNames.map((f) => `${f.name} (${f.from} → ${f.to})`).join('; ')}`
        : null,
    ].filter((part): part is string => part !== null);

    return {
      text: parts.join('\n'),
      structured: {
        company: name,
        cik: resolved.cik,
        tickers,
        exchanges,
        sic: str('sic'),
        sicDescription: str('sicDescription'),
        entityType: str('entityType'),
        category: str('category'),
        stateOfIncorporation: stateCode,
        stateOfIncorporationLabel: stateLabel,
        fiscalYearEnd,
        website: str('website'),
        phone: str('phone'),
        formerNames,
      },
    };
  },
};
