/**
 * The statement line-item table for the sec-edgar `get_financials` tool: the
 * metric definitions (with their US-GAAP/IFRS tag fallbacks) that name each
 * line, plus the small helpers that select tags and units for a taxonomy. The
 * assembly logic that turns these into statements lives in `xbrl.ts`.
 */

// ---------------------------------------------------------------------------
// get_financials: statement definitions
// ---------------------------------------------------------------------------

export type Statement = 'income' | 'balance' | 'cashFlow';

/** A companyfacts taxonomy bucket. */
export type Taxonomy = 'us-gaap' | 'ifrs-full';

export interface MetricDef {
  /** Output key, e.g. "revenue". */
  key: string;
  /** Human label for the text rendering. */
  label: string;
  statement: Statement;
  /** 'money' facts use the company currency; 'perShare' use `<currency>/shares`. */
  unit: 'money' | 'perShare';
  /** US-GAAP tags to try, in preference order (concepts drift across years). */
  gaap: string[];
  /** IFRS tags for foreign filers reporting under ifrs-full. */
  ifrs: string[];
}

/**
 * The statement line items `get_financials` extracts, each with tag fallbacks:
 * companies switch concepts across taxonomy versions (e.g. `Revenues` →
 * `RevenueFromContractWithCustomerExcludingAssessedTax` after ASC 606), so
 * each line tries its tags in order per period.
 */
export const METRICS: MetricDef[] = [
  {
    key: 'revenue',
    label: 'Revenue',
    statement: 'income',
    unit: 'money',
    gaap: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueGoodsNet',
      'RevenueMineralSales',
    ],
    ifrs: ['Revenue', 'RevenueFromContractsWithCustomers'],
  },
  {
    key: 'costOfRevenue',
    label: 'Cost of revenue',
    statement: 'income',
    unit: 'money',
    gaap: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
    ifrs: ['CostOfSales'],
  },
  {
    key: 'grossProfit',
    label: 'Gross profit',
    statement: 'income',
    unit: 'money',
    gaap: ['GrossProfit'],
    ifrs: ['GrossProfit'],
  },
  {
    key: 'researchAndDevelopment',
    label: 'R&D expense',
    statement: 'income',
    unit: 'money',
    gaap: ['ResearchAndDevelopmentExpense'],
    ifrs: ['ResearchAndDevelopmentExpense'],
  },
  {
    key: 'sellingGeneralAndAdministrative',
    label: 'SG&A expense',
    statement: 'income',
    unit: 'money',
    gaap: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
    ifrs: ['SellingGeneralAndAdministrativeExpense'],
  },
  {
    key: 'operatingIncome',
    label: 'Operating income',
    statement: 'income',
    unit: 'money',
    gaap: ['OperatingIncomeLoss'],
    ifrs: ['ProfitLossFromOperatingActivities'],
  },
  {
    key: 'incomeTaxExpense',
    label: 'Income tax expense',
    statement: 'income',
    unit: 'money',
    gaap: ['IncomeTaxExpenseBenefit'],
    ifrs: ['IncomeTaxExpenseContinuingOperations'],
  },
  {
    key: 'netIncome',
    label: 'Net income',
    statement: 'income',
    unit: 'money',
    gaap: ['NetIncomeLoss', 'ProfitLoss'],
    ifrs: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'],
  },
  {
    key: 'epsBasic',
    label: 'EPS (basic)',
    statement: 'income',
    unit: 'perShare',
    gaap: ['EarningsPerShareBasic'],
    ifrs: ['BasicEarningsLossPerShare'],
  },
  {
    key: 'epsDiluted',
    label: 'EPS (diluted)',
    statement: 'income',
    unit: 'perShare',
    gaap: ['EarningsPerShareDiluted'],
    ifrs: ['DilutedEarningsLossPerShare'],
  },
  {
    key: 'cashAndEquivalents',
    label: 'Cash & equivalents',
    statement: 'balance',
    unit: 'money',
    gaap: ['CashAndCashEquivalentsAtCarryingValue'],
    ifrs: ['CashAndCashEquivalents'],
  },
  {
    key: 'currentAssets',
    label: 'Current assets',
    statement: 'balance',
    unit: 'money',
    gaap: ['AssetsCurrent'],
    ifrs: ['CurrentAssets'],
  },
  {
    key: 'totalAssets',
    label: 'Total assets',
    statement: 'balance',
    unit: 'money',
    gaap: ['Assets'],
    ifrs: ['Assets'],
  },
  {
    key: 'currentLiabilities',
    label: 'Current liabilities',
    statement: 'balance',
    unit: 'money',
    gaap: ['LiabilitiesCurrent'],
    ifrs: ['CurrentLiabilities'],
  },
  {
    key: 'longTermDebt',
    label: 'Long-term debt',
    statement: 'balance',
    unit: 'money',
    gaap: ['LongTermDebtNoncurrent', 'LongTermDebt', 'ConvertibleDebtNoncurrent'],
    ifrs: ['NoncurrentPortionOfNoncurrentBorrowings', 'Borrowings'],
  },
  {
    key: 'totalLiabilities',
    label: 'Total liabilities',
    statement: 'balance',
    unit: 'money',
    gaap: ['Liabilities'],
    ifrs: ['Liabilities'],
  },
  {
    key: 'stockholdersEquity',
    label: 'Stockholders’ equity',
    statement: 'balance',
    unit: 'money',
    gaap: [
      'StockholdersEquity',
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
    ifrs: ['Equity', 'EquityAttributableToOwnersOfParent'],
  },
  {
    key: 'liabilitiesAndEquity',
    label: 'Liabilities + equity',
    statement: 'balance',
    unit: 'money',
    gaap: ['LiabilitiesAndStockholdersEquity'],
    ifrs: ['EquityAndLiabilities'],
  },
  {
    key: 'operatingCashFlow',
    label: 'Operating cash flow',
    statement: 'cashFlow',
    unit: 'money',
    gaap: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    ifrs: ['CashFlowsFromUsedInOperatingActivities'],
  },
  {
    key: 'investingCashFlow',
    label: 'Investing cash flow',
    statement: 'cashFlow',
    unit: 'money',
    gaap: [
      'NetCashProvidedByUsedInInvestingActivities',
      'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations',
    ],
    ifrs: ['CashFlowsFromUsedInInvestingActivities'],
  },
  {
    key: 'financingCashFlow',
    label: 'Financing cash flow',
    statement: 'cashFlow',
    unit: 'money',
    gaap: [
      'NetCashProvidedByUsedInFinancingActivities',
      'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations',
    ],
    ifrs: ['CashFlowsFromUsedInFinancingActivities'],
  },
  {
    key: 'capitalExpenditures',
    label: 'Capital expenditures',
    statement: 'cashFlow',
    unit: 'money',
    gaap: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    ifrs: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  },
  {
    key: 'dividendsPaid',
    label: 'Dividends paid',
    statement: 'cashFlow',
    unit: 'money',
    gaap: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
    ifrs: ['DividendsPaidClassifiedAsFinancingActivities'],
  },
];

/** The concepts that anchor period discovery (every filer reports net income). */
export const ANCHOR = METRICS.find((m) => m.key === 'netIncome') as MetricDef;

/** Tags for a metric in the given taxonomy. */
export const tagsFor = (def: MetricDef, taxonomy: Taxonomy): string[] =>
  taxonomy === 'us-gaap' ? def.gaap : def.ifrs;

/** Unit-key preference for a metric given the company currency. */
export const unitPreference = (def: MetricDef, currency: string): string[] =>
  def.unit === 'perShare' ? [`${currency}/shares`] : [currency];
