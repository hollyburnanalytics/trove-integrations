import { defineMcpServer } from '@ontrove/mcp';
import { getApInvoices } from './tools/get-ap-invoices.ts';
import { getApPayments } from './tools/get-ap-payments.ts';
import { getGlAccounts } from './tools/get-gl-accounts.ts';
import { getJobEstimate } from './tools/get-job-estimate.ts';
import { getJobTransactions } from './tools/get-job-transactions.ts';
import { getSubcontractChangeOrders } from './tools/get-subcontract-change-orders.ts';
import { getSubcontracts } from './tools/get-subcontracts.ts';
import { listCompanies } from './tools/list-companies.ts';
import { searchJobs } from './tools/search-jobs.ts';
import { searchVendors } from './tools/search-vendors.ts';

// Re-exported for tests: drop all cached tokens between `callTool` invocations.
export { __resetTokenCache } from './client.ts';

/**
 * Jonas Premier — a hosted MCP server over the Premier Construction Software
 * External API (api.jonas-premier.com), the construction ERP's documented
 * public REST surface. Ten read-only tools cover the accounting core: companies
 * → jobs → job-cost transactions & original estimates, vendors → AP invoices &
 * payments, GL accounts, and subcontracts with their change orders. Each tool
 * lives in its own module under `tools/`, over the shared auth/request plumbing
 * in `client.ts` and the row-field/formatting/schema helpers in `fields.ts`.
 *
 * Auth is an OAuth2 *password* grant against `POST /Authenticate` with the
 * fixed public client id `Premier.ExternalAPI` plus the username/password of an
 * **API user created inside the customer's Premier tenant** — the vendor's
 * documented API access pattern (the credential identifies the tenant; the
 * host is shared). The SDK's declarative `auth` block only speaks
 * client-credentials, so the mint is hand-rolled in `client.ts`: secrets via
 * `ctx.requireSecret('JONAS_USERNAME'/'JONAS_PASSWORD')`, token cached
 * per-user (never per-server — one tenant's token must not serve another),
 * re-minted once on a 401. Set the secrets with
 * `trove secret set jonas-premier JONAS_USERNAME …` (and …PASSWORD…).
 *
 * Every endpoint answers with an `{ Data, Message, Code, Summary }` envelope;
 * `unwrapList` maps that to rows or a clear ToolError. List endpoints paginate
 * via `parameter.pageNumber`/`parameter.pageSize` (max 1000). Amounts are
 * doubles in the tenant's ledger currency.
 */
export default defineMcpServer({
  egress: ['api.jonas-premier.com'],
  tools: [
    listCompanies,
    searchJobs,
    getJobTransactions,
    getJobEstimate,
    searchVendors,
    getApInvoices,
    getApPayments,
    getGlAccounts,
    getSubcontracts,
    getSubcontractChangeOrders,
  ],
});
