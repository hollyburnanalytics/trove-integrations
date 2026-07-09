import { type ToolDefinition, z } from '@ontrove/mcp';
import { companyFactsUrl, edgarJson, fmtMoney, requireCompany } from '../client.ts';
import { METRICS, type Statement } from '../metrics.ts';
import { assembleFinancials, type StatementPeriod } from '../xbrl.ts';

/**
 * `get_financials` — structured financial statements assembled from a
 * company's XBRL facts (see `xbrl.ts` for the assembly rules).
 */

/** One compact text block per period for the human-readable summary. */
function renderPeriod(period: StatementPeriod, currency: string): string {
  const v = period.values;
  const money = (key: string): string | null => {
    const value = v[key];
    return value === null || value === undefined ? null : fmtMoney(value, currency);
  };
  const line = (parts: (string | null)[]): string | null => {
    const kept = parts.filter((part): part is string => part !== null);
    return kept.length > 0 ? `  ${kept.join(' · ')}` : null;
  };
  const identity =
    period.identityOk === null
      ? null
      : period.identityOk
        ? 'A=L+E ✓'
        : `A≠L+E (Δ ${fmtMoney(period.identityDelta ?? 0, currency)})`;
  const lines = [
    `${period.label} (ending ${period.end}; ${period.form} filed ${period.filed}):`,
    line([
      money('revenue') && `Revenue ${money('revenue')}`,
      money('operatingIncome') && `Op income ${money('operatingIncome')}`,
      money('netIncome') && `Net income ${money('netIncome')}`,
      v.epsDiluted !== null && v.epsDiluted !== undefined
        ? `Diluted EPS ${v.epsDiluted.toFixed(2)}`
        : null,
    ]),
    line([
      money('totalAssets') && `Assets ${money('totalAssets')}`,
      money('totalLiabilities') && `Liabilities ${money('totalLiabilities')}`,
      money('stockholdersEquity') && `Equity ${money('stockholdersEquity')}`,
      identity,
    ]),
    line([
      money('operatingCashFlow') && `Operating CF ${money('operatingCashFlow')}`,
      money('capitalExpenditures') && `CapEx ${money('capitalExpenditures')}`,
      money('freeCashFlow') && `FCF ${money('freeCashFlow')}`,
    ]),
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

const moneyValue = z.number().nullable();

/**
 * The per-period output shape. The statement objects must mirror `METRICS`
 * (plus the derived `freeCashFlow`) — a test asserts the key sets stay in
 * sync, so adding a metric means updating both together.
 */
export const statementPeriodShape = z.object({
  label: z.string(),
  start: z.string(),
  end: z.string(),
  fiscalYear: z.number().nullable(),
  fiscalPeriod: z.string().nullable(),
  form: z.string(),
  filed: z.string(),
  accession: z.string(),
  incomeStatement: z.object({
    revenue: moneyValue,
    costOfRevenue: moneyValue,
    grossProfit: moneyValue,
    researchAndDevelopment: moneyValue,
    sellingGeneralAndAdministrative: moneyValue,
    operatingIncome: moneyValue,
    incomeTaxExpense: moneyValue,
    netIncome: moneyValue,
    epsBasic: moneyValue,
    epsDiluted: moneyValue,
  }),
  balanceSheet: z.object({
    cashAndEquivalents: moneyValue,
    currentAssets: moneyValue,
    totalAssets: moneyValue,
    currentLiabilities: moneyValue,
    longTermDebt: moneyValue,
    totalLiabilities: moneyValue,
    stockholdersEquity: moneyValue,
    liabilitiesAndEquity: moneyValue,
  }),
  cashFlow: z.object({
    operatingCashFlow: moneyValue,
    investingCashFlow: moneyValue,
    financingCashFlow: moneyValue,
    capitalExpenditures: moneyValue,
    dividendsPaid: moneyValue,
    freeCashFlow: moneyValue,
  }),
  identityOk: z.boolean().nullable(),
  identityDelta: z.number().nullable(),
  identityChecked: z.boolean(),
});

/** Regroup a period's flat metric values into the three statement objects. */
function shapePeriod(period: StatementPeriod): z.infer<typeof statementPeriodShape> {
  const pick = (statement: Statement): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const def of METRICS) {
      if (def.statement === statement) out[def.key] = period.values[def.key] ?? null;
    }
    return out;
  };
  return {
    label: period.label,
    start: period.start,
    end: period.end,
    fiscalYear: period.fiscalYear,
    fiscalPeriod: period.fiscalPeriod,
    form: period.form,
    filed: period.filed,
    accession: period.accession,
    incomeStatement: pick('income') as z.infer<typeof statementPeriodShape>['incomeStatement'],
    balanceSheet: pick('balance') as z.infer<typeof statementPeriodShape>['balanceSheet'],
    cashFlow: {
      ...pick('cashFlow'),
      freeCashFlow: period.values.freeCashFlow ?? null,
    } as z.infer<typeof statementPeriodShape>['cashFlow'],
    identityOk: period.identityOk,
    identityDelta: period.identityDelta,
    identityChecked: period.identityOk !== null,
  };
}

export const getFinancials: ToolDefinition = {
  name: 'get_financials',
  title: 'EDGAR: Company financials (XBRL)',
  description:
    'Structured financial statements for a public company, straight from its SEC XBRL ' +
    'facts: income statement, balance sheet, and cash flow with several comparative ' +
    'periods in one call. Use annual for fiscal years or quarterly for reported ' +
    'quarters (fiscal Q4 income figures are usually only reported inside the annual ' +
    'totals; quarters furnished on 6-K by foreign private issuers are included). ' +
    "Values are as-reported in the company's filing currency, preferring the " +
    'latest amendment/restatement, and each period carries an assets = liabilities + ' +
    'equity sanity check. For one metric across all of history, use get_xbrl_concept.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z.string().min(1).describe('Ticker ("AAPL", "BRK.B"), company name, or CIK.'),
    period: z
      .enum(['annual', 'quarterly'])
      .default('annual')
      .describe('Fiscal years (annual) or reported fiscal quarters (quarterly).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(4)
      .describe('How many most-recent periods to return (1–12).'),
  }),
  output: z.object({
    company: z.string(),
    cik: z.string(),
    taxonomy: z.string(),
    currency: z.string(),
    periodType: z.string(),
    count: z.number(),
    latestPeriodEnd: z.string().nullable(),
    stale: z.boolean(),
    periods: z.array(statementPeriodShape),
  }),
  async handler(args, ctx) {
    const { company, period, limit } = args;
    ctx.log('get_financials', { company, period, limit });
    const resolved = await requireCompany(ctx, company);
    const body = await edgarJson(
      ctx,
      companyFactsUrl(resolved.cik),
      `SEC EDGAR has no XBRL company facts for "${company}" (CIK ${resolved.cik}).`,
    );
    const name = typeof body.entityName === 'string' ? body.entityName : resolved.name;
    const financials = assembleFinancials(body, period, limit);

    if (financials.periods.length === 0) {
      return {
        text:
          `${name} (CIK ${resolved.cik}) has XBRL facts but no ${period} net-income ` +
          'periods to anchor statements on. Try the other period type.',
        structured: {
          company: name,
          cik: resolved.cik,
          taxonomy: financials.taxonomy,
          currency: financials.currency,
          periodType: period,
          count: 0,
          latestPeriodEnd: null,
          stale: false,
          periods: [],
        },
      };
    }

    // Guardrail: a healthy active filer's newest period is at most one
    // reporting cycle old. Anything much older signals missing coverage
    // (delisting, identifier change) and must never read as current.
    const latestPeriodEnd = financials.periods[0]?.end ?? null;
    const stale =
      latestPeriodEnd !== null && Date.now() - Date.parse(latestPeriodEnd) > 548 * 86_400_000;

    const blocks = financials.periods.map((p) => renderPeriod(p, financials.currency)).join('\n');
    return {
      text:
        `${name} (CIK ${resolved.cik}) — ${period} financials, ${financials.currency} ` +
        '(as reported; latest amendments preferred):\n' +
        blocks +
        (stale
          ? `\n⚠ The newest available period ends ${latestPeriodEnd} — more than one ` +
            'reporting cycle old. Coverage may be incomplete for this filer.'
          : '') +
        '\n(Full line items in the structured output.)',
      structured: {
        company: name,
        cik: resolved.cik,
        taxonomy: financials.taxonomy,
        currency: financials.currency,
        periodType: period,
        count: financials.periods.length,
        latestPeriodEnd,
        stale,
        periods: financials.periods.map(shapePeriod),
      },
    };
  },
};
