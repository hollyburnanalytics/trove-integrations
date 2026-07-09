import { defineMcpServer } from '@ontrove/mcp';
import { companyFilings } from './tools/company-filings.ts';
import { getCompany } from './tools/get-company.ts';
import { getFilingDocument } from './tools/get-filing-document.ts';
import { getFinancials } from './tools/get-financials.ts';
import { getFundHoldings } from './tools/get-fund-holdings.ts';
import { getXbrlConcept } from './tools/get-xbrl-concept.ts';
import { insiderTransactions } from './tools/insider-transactions.ts';
import { searchFilings } from './tools/search-filings.ts';

/**
 * SEC EDGAR — a no-auth hosted MCP server over the public SEC EDGAR + XBRL
 * APIs. Eight read-only surfaces, each mapped to a unit of analyst intent and
 * implemented in its own module under `tools/`:
 *
 *  - `get_financials` — structured financial statements from XBRL facts;
 *  - `get_xbrl_concept` — one XBRL concept across every reported period;
 *  - `get_filing_document` — read a filing's text (paginated, searchable);
 *  - `insider_transactions` — decoded Form 3/4/5 insider activity;
 *  - `get_fund_holdings` — a 13F institutional manager's portfolio;
 *  - `get_company` — the SEC's registrant profile;
 *  - `search_filings` — full-text search across all filings;
 *  - `company_filings` — one company's filing history, filtered.
 *
 * Everything is deterministic parsing of the SEC's structured data (JSON APIs
 * and fixed XML schemas) — no fuzzy scraping. Facts are matched by fiscal
 * window regardless of which form reported them, so foreign private issuers
 * whose numbers arrive in 6-K furnishings are covered too.
 */
export default defineMcpServer({
  tools: [
    getFinancials,
    getXbrlConcept,
    getFilingDocument,
    insiderTransactions,
    getFundHoldings,
    getCompany,
    searchFilings,
    companyFilings,
  ],
});
