import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import {
  edgarDocument,
  filingDirUrl,
  fmtMoney,
  normalizeAccession,
  requireCompany,
} from '../client.ts';
import { listFilingDocuments } from '../documents.ts';
import { recentFilings } from '../submissions.ts';
import { aggregateHoldings, parseCoverPage, parseInfoTable } from '../thirteenf.ts';

/**
 * `get_fund_holdings` — a 13F manager's portfolio (see `thirteenf.ts` for the
 * information-table parsing and value-unit detection rules).
 */

export const getFundHoldings: ToolDefinition = {
  name: 'get_fund_holdings',
  title: 'EDGAR: 13F fund holdings',
  description:
    "An institutional manager's portfolio from its latest 13F-HR filing (or a " +
    'specific one by accession): top holdings by market value with shares, put/call ' +
    'flags, and portfolio percentages. Works for hedge funds and asset managers ' +
    '(e.g. "Berkshire Hathaway", "BlackRock") — 13Fs exist only for managers with ' +
    '$100M+ in US-listed equities, and report long US equity positions quarterly ' +
    '(45-day lag), not shorts or most bonds. Values are normalized to whole dollars.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z.string().min(1).describe('Fund manager name, ticker, or CIK.'),
    accession: z
      .string()
      .regex(/^\d{10}-?\d{2}-?\d{6}$/)
      .optional()
      .describe('A specific 13F filing accession (defaults to the most recent 13F-HR).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(25)
      .describe('How many top holdings to return (1–200).'),
  }),
  output: z.object({
    company: z.string(),
    cik: z.string(),
    form: z.string(),
    accession: z.string(),
    periodOfReport: z.string().nullable(),
    amendmentType: z.string().nullable(),
    valueUnits: z.string(),
    totalValue: z.number(),
    totalCheckOk: z.boolean().nullable(),
    positions: z.number(),
    count: z.number(),
    holdings: z.array(
      z.object({
        issuer: z.string().nullable(),
        titleOfClass: z.string().nullable(),
        cusip: z.string().nullable(),
        value: z.number(),
        shares: z.number().nullable(),
        sharesType: z.string().nullable(),
        putCall: z.string().nullable(),
        percent: z.number(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { company, limit } = args;
    ctx.log('get_fund_holdings', { company, accession: args.accession, limit });
    const resolved = await requireCompany(ctx, company);
    const { name, filings } = await recentFilings(ctx, resolved.cik);

    let accession = args.accession;
    let form = '13F-HR';
    if (accession) {
      accession = normalizeAccession(accession);
      form = filings.find((f) => f.accession === accession)?.form ?? '13F';
    } else {
      const hr = filings.find((f) => f.form === '13F-HR' || f.form === '13F-HR/A');
      if (!hr) {
        const nt = filings.find((f) => f.form.startsWith('13F-NT'));
        throw new ToolError(
          nt
            ? `${name || company} files 13F-NT notices — its holdings are reported by ` +
                'another manager, so there is no information table here.'
            : `No 13F-HR filings found for ${name || company} (CIK ${resolved.cik}). ` +
                'Only institutional managers with $100M+ in US equities file 13Fs.',
          { retryable: false },
        );
      }
      accession = hr.accession;
      form = hr.form;
    }

    // The information table is the non-primary XML attachment; identify it
    // by content, tolerating namespace prefixes. Deliberately sequential:
    // the shared egress client already throttles to the SEC's fair-access
    // rate, so parallel fetches would only queue there.
    const entries = await listFilingDocuments(ctx, resolved.cik, accession);
    const xmlEntries = entries.filter((entry) => entry.extension === 'xml');
    let coverXml = '';
    let tableXml = '';
    for (const entry of xmlEntries) {
      const body = await edgarDocument(
        ctx,
        `${filingDirUrl(resolved.cik, accession)}/${entry.name}`,
        `Document ${entry.name} missing from ${accession}.`,
      );
      if (/<(?:\w+:)?infoTable[\s>]/.test(body)) tableXml = body;
      else if (/<(?:\w+:)?edgarSubmission[\s>]/.test(body)) coverXml = body;
    }
    if (!tableXml) {
      throw new ToolError(
        `Filing ${accession} has no 13F information table (13F-NT notices and some ` +
          'amendments carry none).',
        { retryable: false },
      );
    }

    const cover = parseCoverPage(coverXml);
    const table = parseInfoTable(tableXml, cover.periodOfReport);
    const aggregated = aggregateHoldings(table.holdings);
    const totalValue = aggregated.reduce((sum, h) => sum + h.value, 0);
    const declaredTotal =
      cover.tableValueTotal === null
        ? null
        : cover.tableValueTotal * (table.valueUnits === 'thousands' ? 1000 : 1);
    const totalCheckOk =
      declaredTotal === null || totalValue === 0
        ? null
        : Math.abs(totalValue - declaredTotal) <= Math.abs(declaredTotal) * 0.01;
    const top = aggregated.slice(0, limit).map((h) => ({
      issuer: h.issuer,
      titleOfClass: h.titleOfClass,
      cusip: h.cusip,
      value: h.value,
      shares: h.shares,
      sharesType: h.sharesType,
      putCall: h.putCall,
      percent: totalValue > 0 ? Math.round((h.value / totalValue) * 10_000) / 100 : 0,
    }));

    const manager = cover.manager ?? name ?? company;
    const lines = top
      .map((h, i) => {
        const flag = h.putCall ? ` [${h.putCall}]` : '';
        const shares = h.shares === null ? '' : ` · ${h.shares.toLocaleString('en-US')} sh`;
        return `  ${i + 1}. ${h.issuer ?? '?'}${flag} — ${fmtMoney(h.value, 'USD')} (${h.percent}%)${shares}`;
      })
      .join('\n');
    const amendment = cover.amendmentType ? ` (${cover.amendmentType} amendment)` : '';
    const check = totalCheckOk === false ? ' ⚠ sum differs from the declared total' : '';
    return {
      text:
        `${manager} — ${form}${amendment} for period ending ${cover.periodOfReport ?? '?'}: ` +
        `${aggregated.length} position(s), ${fmtMoney(totalValue, 'USD')} total${check}.\n` +
        `Top ${top.length}:\n${lines}`,
      structured: {
        company: manager,
        cik: resolved.cik,
        form,
        accession,
        periodOfReport: cover.periodOfReport,
        amendmentType: cover.amendmentType,
        valueUnits: table.valueUnits,
        totalValue,
        totalCheckOk,
        positions: aggregated.length,
        count: top.length,
        holdings: top,
      },
    };
  },
};
