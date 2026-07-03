import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * Jonas Premier — a hosted MCP server over the Premier Construction Software
 * External API (api.jonas-premier.com), the construction ERP's documented
 * public REST surface. Ten read-only tools cover the accounting core: companies
 * → jobs → job-cost transactions & original estimates, vendors → AP invoices &
 * payments, GL accounts, and subcontracts with their change orders.
 *
 * Auth is an OAuth2 *password* grant against `POST /Authenticate` with the
 * fixed public client id `Premier.ExternalAPI` plus the username/password of an
 * **API user created inside the customer's Premier tenant** — the vendor's
 * documented integration pattern (the credential identifies the tenant; the
 * host is shared). The SDK's declarative `auth` block only speaks
 * client-credentials, so the mint is hand-rolled below: secrets via
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

/** Base host for the Premier External API (shared across tenants). */
const BASE_URL = 'https://api.jonas-premier.com';

/** Fixed public client id for the password grant (per the vendor's API docs). */
const AUTH_CLIENT_ID = 'Premier.ExternalAPI';

/** Fallback token lifetime when the mint response omits `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** Refresh this long before nominal expiry so in-flight calls never race it. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * Per-user token cache. Premier credentials are per-tenant secrets, so the
 * cache key MUST be the calling user — a server-wide token would let one
 * tenant's calls ride on another's session (same hazard the SDK notes for its
 * own client-credentials cache).
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Single-flight guards so concurrent calls per user share one mint. */
const mintsInFlight = new Map<string, Promise<string>>();

/** Test hook: drop all cached tokens (module state survives across calls). */
export function __resetTokenCache(): void {
  tokenCache.clear();
  mintsInFlight.clear();
}

/** POST the password grant and cache the bearer for this user. */
async function mintToken(ctx: ToolContext): Promise<string> {
  const username = await ctx.requireSecret('JONAS_USERNAME');
  const password = await ctx.requireSecret('JONAS_PASSWORD');
  const form = new URLSearchParams({
    grant_type: 'password',
    client_id: AUTH_CLIENT_ID,
    username,
    password,
  });
  const res = await ctx.fetch(`${BASE_URL}/Authenticate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ToolError(
        'Premier rejected the API credentials. Check JONAS_USERNAME/JONAS_PASSWORD — they must ' +
          'belong to an API user created in the Premier tenant (Settings → API users).',
        { retryable: false },
      );
    }
    throw new ToolError(`Premier auth endpoint returned ${res.status}.`, {
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ToolError('Premier auth returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const token = obj.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new ToolError('Premier auth response carried no access token; try again shortly.', {
      retryable: true,
    });
  }
  const ttl = typeof obj.expires_in === 'number' ? obj.expires_in : DEFAULT_TOKEN_TTL_SECONDS;
  tokenCache.set(ctx.userId, {
    token,
    expiresAt: Date.now() + ttl * 1000 - TOKEN_EXPIRY_BUFFER_MS,
  });
  return token;
}

/** Return a live bearer for this user, minting (single-flight) when needed. */
async function getToken(ctx: ToolContext): Promise<string> {
  const cached = tokenCache.get(ctx.userId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  let mint = mintsInFlight.get(ctx.userId);
  if (!mint) {
    mint = mintToken(ctx).finally(() => mintsInFlight.delete(ctx.userId));
    mintsInFlight.set(ctx.userId, mint);
  }
  return mint;
}

/** Encode defined params as Premier's `parameter.<name>` query string. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(`parameter.${key}`, String(value));
  }
  return qs.toString();
}

/** Unwrap Premier's `{ Data, Message, Code }` envelope into rows. */
function unwrapList(parsed: unknown): Record<string, unknown>[] {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolError('Premier returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const envelope = parsed as Record<string, unknown>;
  if (Array.isArray(envelope.Data)) {
    return envelope.Data.map((row) =>
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {},
    );
  }
  const message = typeof envelope.Message === 'string' ? envelope.Message.trim() : '';
  if (message) {
    throw new ToolError(`Premier reported an error: ${message}`, { retryable: false });
  }
  return [];
}

/**
 * GET a Premier endpoint with the user's bearer attached, unwrap the envelope.
 * On a 401 the cached token is dropped and the request retried once with a
 * fresh mint (API-user sessions can be revoked server-side before expiry).
 */
async function jonasGet(
  path: string,
  params: Record<string, string | number | undefined>,
  ctx: ToolContext,
  retried = false,
): Promise<Record<string, unknown>[]> {
  const token = await getToken(ctx);
  const query = buildQuery(params);
  const res = await ctx.fetch(`${BASE_URL}${path}${query ? `?${query}` : ''}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && !retried) {
    tokenCache.delete(ctx.userId);
    return jonasGet(path, params, ctx, true);
  }
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ToolError(
        'Premier refused the request even after re-authenticating — the API user may lack ' +
          'permission for this module, or the credentials were revoked.',
        { retryable: false },
      );
    }
    if (res.status === 400 || res.status === 404) {
      let reason = '';
      try {
        const parsed = JSON.parse(body) as { Message?: unknown; message?: unknown };
        const m = parsed.Message ?? parsed.message;
        if (typeof m === 'string') reason = m;
      } catch {
        reason = body.slice(0, 120);
      }
      throw new ToolError(`Premier rejected the request: ${reason || `HTTP ${res.status}`}.`, {
        retryable: false,
      });
    }
    throw new ToolError(`Premier returned ${res.status}: ${body.slice(0, 100)}`, {
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ToolError('Premier returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  return unwrapList(parsed);
}

/** Read a string prop, or null (Premier omits/nulls fields freely). */
const str = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key];
  return typeof v === 'string' && v !== '' ? v : null;
};

/** Read a finite number prop, or null. */
const num = (row: Record<string, unknown>, key: string): number | null => {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** Read a boolean-ish prop (GL fields arrive as "True"/"False" strings), or null. */
const boolish = (row: Record<string, unknown>, key: string): boolean | null => {
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
const sum = (rows: { [k: string]: unknown }[], key: string): number =>
  rows.reduce((acc, r) => acc + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);

/** Format an amount for the text summary (ledger currency, 2 dp). */
const fmt = (n: number | null): string =>
  n === null
    ? '?'
    : n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An ISO date or datetime, e.g. "2026-01-31" or "2026-01-31T00:00:00". */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Use ISO format, e.g. 2026-01-31 or 2026-01-31T00:00:00');

/** Shared pagination inputs (Premier caps pageSize at 1000). */
const pageInput = {
  page: z.number().int().min(1).default(1).describe('Page number (default 1).'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(50)
    .describe('Records per page (1–1000, default 50).'),
};

const uuid = (label: string) => z.string().min(1).describe(label);

export default defineMcpServer({
  egress: ['api.jonas-premier.com'],
  tools: [
    {
      name: 'list_companies',
      title: 'Premier: List companies',
      description:
        'List the companies in the Premier tenant (a tenant is multi-company). Returns each ' +
        "company's id, code, name, and business number. Almost every other tool needs a " +
        'companyId from here — call this first.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        search: z.string().optional().describe('Keyword search across companies.'),
        status: z
          .enum(['Active', 'Not Active', 'All'])
          .default('Active')
          .describe('Company status filter (default Active).'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        companies: z.array(
          z.object({
            companyId: z.string().nullable(),
            companyCode: z.string().nullable(),
            companyName: z.string().nullable(),
            businessNumber: z.string().nullable(),
            city: z.string().nullable(),
            active: z.boolean().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('list_companies', { search: args.search, page: args.page });
        const rows = await jonasGet(
          '/api/Company/GetCompanies',
          {
            search: args.search,
            status: args.status,
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const companies = rows.map((r) => ({
          companyId: str(r, 'CompanyId'),
          companyCode: str(r, 'CompanyCode'),
          companyName: str(r, 'CompanyName'),
          businessNumber: str(r, 'BusinessNumber'),
          city: str(r, 'City'),
          active: boolish(r, 'Active'),
        }));
        if (companies.length === 0) {
          return { text: 'No companies matched.', structured: { count: 0, companies: [] } };
        }
        const lines = companies
          .map((c) => `  ${c.companyCode ?? '?'} — ${c.companyName ?? '?'} [${c.companyId ?? '?'}]`)
          .join('\n');
        return {
          text: `${companies.length} company(ies):\n${lines}`,
          structured: { count: companies.length, companies },
        };
      },
    },
    {
      name: 'search_jobs',
      title: 'Premier: Search jobs',
      description:
        'Find jobs (projects) in one company by number, name, or keyword. Returns job id, ' +
        'number, name, status, and address — the jobId/jobNumber feed the job-cost, estimate, ' +
        'and subcontract tools.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        jobNumber: z.string().optional().describe('Filter by exact job number.'),
        jobName: z.string().optional().describe('Filter by job name.'),
        status: z
          .enum(['Active', 'All'])
          .default('Active')
          .describe('Job status filter (default Active).'),
        search: z.string().optional().describe('Keyword search across jobs.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        jobs: z.array(
          z.object({
            jobId: z.string().nullable(),
            jobNumber: z.string().nullable(),
            jobName: z.string().nullable(),
            jobStatus: z.string().nullable(),
            active: z.boolean().nullable(),
            city: z.string().nullable(),
            zipCode: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('search_jobs', { companyId: args.companyId, search: args.search });
        const rows = await jonasGet(
          '/api/Job/GetJobs',
          {
            companyId: args.companyId,
            jobNumber: args.jobNumber,
            jobName: args.jobName,
            status: args.status,
            search: args.search,
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const jobs = rows.map((r) => ({
          jobId: str(r, 'JobId'),
          jobNumber: str(r, 'JobNumber'),
          jobName: str(r, 'JobName'),
          jobStatus: str(r, 'JobStatus'),
          active: boolish(r, 'Active'),
          city: str(r, 'City'),
          zipCode: str(r, 'ZipCode'),
        }));
        if (jobs.length === 0) {
          return { text: 'No jobs matched.', structured: { count: 0, jobs: [] } };
        }
        const lines = jobs
          .map((j) => `  ${j.jobNumber ?? '?'} — ${j.jobName ?? '?'} [${j.jobStatus ?? '?'}]`)
          .join('\n');
        return {
          text: `${jobs.length} job(s):\n${lines}`,
          structured: { count: jobs.length, jobs },
        };
      },
    },
    {
      name: 'get_job_transactions',
      title: 'Premier: Get job-cost transactions',
      description:
        'Pull job-cost ledger lines (actuals) for a company over a required updated-date range — ' +
        'cost item/type, vendor, PO/subcontract linkage, qty, unit cost, and cost per line, plus ' +
        'a page total. The core "what did we actually spend on job X" query; filter by job, ' +
        'cost item, cost type, or Cost/Revenue.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Company Id or company code.'),
        updatedFrom: isoDate.describe('Start of the updated-date range (required by Premier).'),
        updatedTo: isoDate.describe('End of the updated-date range (required by Premier).'),
        job: z.string().optional().describe('Job Id or job number.'),
        costItem: z.string().optional().describe('Cost item Id or code.'),
        costType: z.string().optional().describe('Cost type Id or code.'),
        costOrRevenue: z
          .enum(['Cost', 'Revenue', 'All'])
          .default('Cost')
          .describe('Transaction side (default Cost).'),
        search: z.string().optional().describe('Keyword search across lines.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        totalCost: z.number(),
        transactions: z.array(
          z.object({
            jobNumber: z.string().nullable(),
            jobName: z.string().nullable(),
            costItemCode: z.string().nullable(),
            costItemDescription: z.string().nullable(),
            costTypeCode: z.string().nullable(),
            transactionType: z.string().nullable(),
            transactionDate: z.string().nullable(),
            transactionRefNumber: z.string().nullable(),
            lineDescription: z.string().nullable(),
            vendorName: z.string().nullable(),
            poNumber: z.string().nullable(),
            subcontractNumber: z.string().nullable(),
            qty: z.number().nullable(),
            unitCost: z.number().nullable(),
            cost: z.number().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_job_transactions', { company: args.company, job: args.job });
        const rows = await jonasGet(
          '/api/Job/GetJobTransactions',
          {
            company: args.company,
            job: args.job,
            costItem: args.costItem,
            costType: args.costType,
            costOrRevenue: args.costOrRevenue,
            updatedFrom: args.updatedFrom,
            updatedTo: args.updatedTo,
            search: args.search,
            view: 'Normal',
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const transactions = rows.map((r) => ({
          jobNumber: str(r, 'JobNumber'),
          jobName: str(r, 'JobName'),
          costItemCode: str(r, 'CostItemCode'),
          costItemDescription: str(r, 'CostItemDescription'),
          costTypeCode: str(r, 'CostTypeCode'),
          transactionType: str(r, 'TransactionType'),
          transactionDate: str(r, 'TransactionDate'),
          transactionRefNumber: str(r, 'TransactionRefNumber'),
          lineDescription: str(r, 'LineDescription'),
          vendorName: str(r, 'VendorName'),
          poNumber: str(r, 'PONumber'),
          subcontractNumber: str(r, 'SubcontractNumber'),
          qty: num(r, 'Qty'),
          unitCost: num(r, 'UnitCost'),
          cost: num(r, 'Cost'),
        }));
        const totalCost = sum(transactions, 'cost');
        if (transactions.length === 0) {
          return {
            text: 'No job transactions in that range.',
            structured: { count: 0, totalCost: 0, transactions: [] },
          };
        }
        const lines = transactions
          .slice(0, 15)
          .map(
            (t) =>
              `  ${t.transactionDate?.slice(0, 10) ?? '?'} ${t.jobNumber ?? '?'} ` +
              `${t.costItemCode ?? '?'}/${t.costTypeCode ?? '?'} — ${fmt(t.cost)}` +
              `${t.vendorName ? ` · ${t.vendorName}` : ''}`,
          )
          .join('\n');
        return {
          text:
            `${transactions.length} transaction line(s), page total ${fmt(totalCost)}:\n${lines}` +
            (transactions.length > 15 ? `\n  … and ${transactions.length - 15} more` : ''),
          structured: { count: transactions.length, totalCost, transactions },
        };
      },
    },
    {
      name: 'get_job_estimate',
      title: 'Premier: Get original estimate',
      description:
        'Fetch the original estimate (budget) lines for a job — cost item/type, qty, unit ' +
        'cost, cost, and revenue per line, plus page totals. Pair with get_job_transactions ' +
        'for budget-vs-actual.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        company: z.string().min(1).describe('Company Id or company code.'),
        job: z.string().optional().describe('Job Id or job number.'),
        costItem: z.string().optional().describe('Cost item Id or code.'),
        costType: z.string().optional().describe('Cost type Id or code.'),
        search: z.string().optional().describe('Keyword search across lines.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        totalCost: z.number(),
        totalRevenue: z.number(),
        estimateLines: z.array(
          z.object({
            jobNumber: z.string().nullable(),
            jobName: z.string().nullable(),
            costItemCode: z.string().nullable(),
            costItemDescription: z.string().nullable(),
            costTypeCode: z.string().nullable(),
            lineDescription: z.string().nullable(),
            qty: z.number().nullable(),
            unitCost: z.number().nullable(),
            cost: z.number().nullable(),
            revenue: z.number().nullable(),
            vendorName: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_job_estimate', { company: args.company, job: args.job });
        const rows = await jonasGet(
          '/api/Job/GetOriginalEstimate',
          {
            company: args.company,
            job: args.job,
            costItem: args.costItem,
            costType: args.costType,
            search: args.search,
            view: 'Normal',
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const estimateLines = rows.map((r) => ({
          jobNumber: str(r, 'JobNumber'),
          jobName: str(r, 'JobName'),
          costItemCode: str(r, 'CostItemCode'),
          costItemDescription: str(r, 'CostItemDescription'),
          costTypeCode: str(r, 'CostTypeCode'),
          lineDescription: str(r, 'OriginalEstimateLineDescription'),
          qty: num(r, 'Qty'),
          unitCost: num(r, 'UnitCost'),
          cost: num(r, 'Cost'),
          revenue: num(r, 'Revenue'),
          vendorName: str(r, 'VendorName'),
        }));
        const totalCost = sum(estimateLines, 'cost');
        const totalRevenue = sum(estimateLines, 'revenue');
        if (estimateLines.length === 0) {
          return {
            text: 'No estimate lines matched.',
            structured: { count: 0, totalCost: 0, totalRevenue: 0, estimateLines: [] },
          };
        }
        const lines = estimateLines
          .slice(0, 15)
          .map(
            (e) =>
              `  ${e.jobNumber ?? '?'} ${e.costItemCode ?? '?'}/${e.costTypeCode ?? '?'} — ` +
              `cost ${fmt(e.cost)}, revenue ${fmt(e.revenue)}`,
          )
          .join('\n');
        return {
          text:
            `${estimateLines.length} estimate line(s), cost ${fmt(totalCost)} / revenue ` +
            `${fmt(totalRevenue)}:\n${lines}` +
            (estimateLines.length > 15 ? `\n  … and ${estimateLines.length - 15} more` : ''),
          structured: { count: estimateLines.length, totalCost, totalRevenue, estimateLines },
        };
      },
    },
    {
      name: 'search_vendors',
      title: 'Premier: Search vendors',
      description:
        'Find vendors (subs & suppliers) in one company by name, code, or business number. ' +
        'Returns vendorId AND apSubledgerId — get_ap_invoices/get_ap_payments require that ' +
        'apSubledgerId, so look the vendor up here first.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        vendorName: z.string().optional().describe('Filter by vendor name.'),
        vendorCode: z.string().optional().describe('Filter by vendor code.'),
        businessNumber: z.string().optional().describe('Filter by business number / federal id.'),
        status: z
          .enum(['Active', 'Not Active', 'All'])
          .default('Active')
          .describe('Vendor status filter (default Active).'),
        search: z.string().optional().describe('Keyword search across vendors.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        vendors: z.array(
          z.object({
            vendorId: z.string().nullable(),
            apSubledgerId: z.string().nullable(),
            vendorCode: z.string().nullable(),
            vendorName: z.string().nullable(),
            businessNumber: z.string().nullable(),
            city: z.string().nullable(),
            email: z.string().nullable(),
            phone: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('search_vendors', { companyId: args.companyId, search: args.search });
        const rows = await jonasGet(
          '/api/Vendor/GetVendors',
          {
            companyId: args.companyId,
            vendorName: args.vendorName,
            vendorCode: args.vendorCode,
            businessNumber: args.businessNumber,
            status: args.status,
            search: args.search,
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const vendors = rows.map((r) => ({
          vendorId: str(r, 'VendorId'),
          apSubledgerId: str(r, 'APSubledgerId'),
          vendorCode: str(r, 'VendorCode'),
          vendorName: str(r, 'VendorName'),
          businessNumber: str(r, 'BusinessNumber'),
          city: str(r, 'City'),
          email: str(r, 'Email'),
          phone: str(r, 'Phone1'),
        }));
        if (vendors.length === 0) {
          return { text: 'No vendors matched.', structured: { count: 0, vendors: [] } };
        }
        const lines = vendors
          .map((v) => `  ${v.vendorCode ?? '?'} — ${v.vendorName ?? '?'} [${v.vendorId ?? '?'}]`)
          .join('\n');
        return {
          text: `${vendors.length} vendor(s):\n${lines}`,
          structured: { count: vendors.length, vendors },
        };
      },
    },
    {
      name: 'get_ap_invoices',
      title: 'Premier: Get AP invoices',
      description:
        'List AP invoices for a company + AP subledger (get apSubledgerId from search_vendors) — ' +
        'invoice/due/transaction dates, job, subcontract, PO, subtotal, tax, total, invoice ' +
        'status (Pending/O/S/Paid/Void) and approval status, plus a page total. The ' +
        '"what do we owe, and on which job" query.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        apSubledgerId: uuid('AP subledger Id (from a search_vendors result).'),
        vendorId: z.string().optional().describe('Filter by vendor Id.'),
        vendorName: z.string().optional().describe('Filter by vendor name.'),
        vendorCode: z.string().optional().describe('Filter by vendor code.'),
        invoiceNumber: z.string().optional().describe('Filter by invoice number.'),
        status: z
          .enum(['Pending', 'O/S', 'Paid', 'Void', 'All'])
          .default('All')
          .describe('Invoice status (O/S = outstanding; default All).'),
        transactionDateFrom: isoDate.optional().describe('Start of transaction-date range.'),
        transactionDateTo: isoDate.optional().describe('End of transaction-date range.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        totalAmount: z.number(),
        invoices: z.array(
          z.object({
            invoiceId: z.string().nullable(),
            vendorCode: z.string().nullable(),
            vendorName: z.string().nullable(),
            invoiceNumber: z.string().nullable(),
            invoiceDate: z.string().nullable(),
            dueDate: z.string().nullable(),
            transactionDate: z.string().nullable(),
            jobNumber: z.string().nullable(),
            subcontractNumber: z.string().nullable(),
            purchaseOrderNumber: z.string().nullable(),
            subTotal: z.number().nullable(),
            totalTax: z.number().nullable(),
            invoiceTotal: z.number().nullable(),
            invoiceStatus: z.string().nullable(),
            approvalStatus: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_ap_invoices', { companyId: args.companyId, status: args.status });
        const rows = await jonasGet(
          '/api/APInvoice/GetInvoices',
          {
            companyId: args.companyId,
            aPSubledgerId: args.apSubledgerId,
            vendorId: args.vendorId,
            vendorName: args.vendorName,
            vendorCode: args.vendorCode,
            invoiceNumber: args.invoiceNumber,
            status: args.status,
            transactionDateFrom: args.transactionDateFrom,
            transactionDateTo: args.transactionDateTo,
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const invoices = rows.map((r) => ({
          invoiceId: str(r, 'InvoiceId'),
          vendorCode: str(r, 'VendorCode'),
          vendorName: str(r, 'VendorName'),
          invoiceNumber: str(r, 'InvoiceNumber'),
          invoiceDate: str(r, 'InvoiceDate'),
          dueDate: str(r, 'DueDate'),
          transactionDate: str(r, 'TransactionDate'),
          jobNumber: str(r, 'JobNumber'),
          subcontractNumber: str(r, 'SubcontractNumber'),
          purchaseOrderNumber: str(r, 'PurchaseOrderNumber'),
          subTotal: num(r, 'SubTotal'),
          totalTax: num(r, 'TotalTax'),
          invoiceTotal: num(r, 'InvoiceTotal'),
          invoiceStatus: str(r, 'InvoiceStatus'),
          approvalStatus: str(r, 'ApprovalStatus'),
        }));
        const totalAmount = sum(invoices, 'invoiceTotal');
        if (invoices.length === 0) {
          return {
            text: 'No AP invoices matched.',
            structured: { count: 0, totalAmount: 0, invoices: [] },
          };
        }
        const lines = invoices
          .slice(0, 15)
          .map(
            (i) =>
              `  ${i.invoiceNumber ?? '?'} · ${i.vendorName ?? '?'} — ${fmt(i.invoiceTotal)} ` +
              `[${i.invoiceStatus ?? '?'}]${i.jobNumber ? ` · job ${i.jobNumber}` : ''}` +
              `${i.dueDate ? ` · due ${i.dueDate.slice(0, 10)}` : ''}`,
          )
          .join('\n');
        return {
          text:
            `${invoices.length} AP invoice(s), page total ${fmt(totalAmount)}:\n${lines}` +
            (invoices.length > 15 ? `\n  … and ${invoices.length - 15} more` : ''),
          structured: { count: invoices.length, totalAmount, invoices },
        };
      },
    },
    {
      name: 'get_ap_payments',
      title: 'Premier: Get AP payments',
      description:
        'List AP payments for a company + AP subledger (get apSubledgerId from search_vendors) — ' +
        'payee, payment/check number, amount, date, method, and status, plus a page total. ' +
        'The "what went out the door, when, and how" query.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        apSubledgerId: uuid('AP subledger Id (from a search_vendors result).'),
        vendorId: z.string().optional().describe('Filter by vendor Id.'),
        vendorName: z.string().optional().describe('Filter by vendor name.'),
        vendorCode: z.string().optional().describe('Filter by vendor code.'),
        paymentNumber: z.string().optional().describe('Filter by payment / check ref number.'),
        paymentDateFrom: isoDate.optional().describe('Start of payment-date range.'),
        paymentDateTo: isoDate.optional().describe('End of payment-date range.'),
        includeCancelled: z
          .boolean()
          .default(false)
          .describe('Include cancelled payments (default false).'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        totalAmount: z.number(),
        payments: z.array(
          z.object({
            paymentId: z.string().nullable(),
            vendorCode: z.string().nullable(),
            vendorName: z.string().nullable(),
            payee: z.string().nullable(),
            paymentNumber: z.string().nullable(),
            amount: z.number().nullable(),
            paymentDate: z.string().nullable(),
            paymentMethod: z.string().nullable(),
            memo: z.string().nullable(),
            status: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_ap_payments', { companyId: args.companyId });
        const rows = await jonasGet(
          '/api/APPayment/GetPayments',
          {
            companyId: args.companyId,
            aPSubledgerId: args.apSubledgerId,
            vendorId: args.vendorId,
            vendorName: args.vendorName,
            vendorCode: args.vendorCode,
            paymentNumber: args.paymentNumber,
            paymentDateFrom: args.paymentDateFrom,
            paymentDateTo: args.paymentDateTo,
            includeCancelled: args.includeCancelled ? 'yes' : 'no',
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const payments = rows.map((r) => ({
          paymentId: str(r, 'PaymentId'),
          vendorCode: str(r, 'VendorCode'),
          vendorName: str(r, 'VendorName'),
          payee: str(r, 'Payee'),
          paymentNumber: str(r, 'PaymentNumber'),
          amount: num(r, 'Amount'),
          paymentDate: str(r, 'PaymentDate'),
          paymentMethod: str(r, 'PaymentMethod'),
          memo: str(r, 'Memo'),
          status: str(r, 'Status'),
        }));
        const totalAmount = sum(payments, 'amount');
        if (payments.length === 0) {
          return {
            text: 'No AP payments matched.',
            structured: { count: 0, totalAmount: 0, payments: [] },
          };
        }
        const lines = payments
          .slice(0, 15)
          .map(
            (p) =>
              `  ${p.paymentDate?.slice(0, 10) ?? '?'} #${p.paymentNumber ?? '?'} · ` +
              `${p.payee ?? p.vendorName ?? '?'} — ${fmt(p.amount)} [${p.paymentMethod ?? '?'}]`,
          )
          .join('\n');
        return {
          text:
            `${payments.length} payment(s), page total ${fmt(totalAmount)}:\n${lines}` +
            (payments.length > 15 ? `\n  … and ${payments.length - 15} more` : ''),
          structured: { count: payments.length, totalAmount, payments },
        };
      },
    },
    {
      name: 'get_gl_accounts',
      title: 'Premier: Get GL accounts',
      description:
        'List general-ledger accounts for one company — number, name, type, statement type ' +
        '(BS/IS), currency, and whether sub-accounts exist. The chart-of-accounts lookup ' +
        'behind any GL-coded question.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        accountNumber: z.string().optional().describe('Filter by account number.'),
        status: z
          .enum(['Active', 'Not Active', 'All'])
          .default('Active')
          .describe('Account status filter (default Active).'),
        search: z.string().optional().describe('Keyword search across accounts.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        accounts: z.array(
          z.object({
            accountId: z.string().nullable(),
            accountNumber: z.string().nullable(),
            accountName: z.string().nullable(),
            accountType: z.string().nullable(),
            statementType: z.string().nullable(),
            currency: z.string().nullable(),
            hasSubAccounts: z.boolean().nullable(),
            active: z.boolean().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_gl_accounts', { companyId: args.companyId, search: args.search });
        const rows = await jonasGet(
          '/api/GL/GetAccounts',
          {
            companyId: args.companyId,
            accountNumber: args.accountNumber,
            status: args.status,
            search: args.search,
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const accounts = rows.map((r) => ({
          accountId: str(r, 'AccountId'),
          accountNumber: str(r, 'AccountNumber'),
          accountName: str(r, 'AccountName'),
          accountType: str(r, 'AccountType'),
          statementType: str(r, 'StatementType'),
          currency: str(r, 'Currency'),
          hasSubAccounts: boolish(r, 'HasSubAccounts'),
          active: boolish(r, 'Active'),
        }));
        if (accounts.length === 0) {
          return { text: 'No GL accounts matched.', structured: { count: 0, accounts: [] } };
        }
        const lines = accounts
          .slice(0, 25)
          .map(
            (a) =>
              `  ${a.accountNumber ?? '?'} — ${a.accountName ?? '?'} ` +
              `[${a.accountType ?? '?'}${a.currency ? ` · ${a.currency}` : ''}]`,
          )
          .join('\n');
        return {
          text:
            `${accounts.length} GL account(s):\n${lines}` +
            (accounts.length > 25 ? `\n  … and ${accounts.length - 25} more` : ''),
          structured: { count: accounts.length, accounts },
        };
      },
    },
    {
      name: 'get_subcontracts',
      title: 'Premier: Get subcontracts',
      description:
        'List subcontract commitments for a company — vendor, job, contract amount, holdback % ' +
        '(builders-lien holdback), and per-line breakdown with invoiced balance, plus a page ' +
        'total. Filter by job or vendor; the committed-cost side of budget-vs-committed-vs-actual.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        jobId: z.string().optional().describe('Filter by job Id.'),
        jobNumber: z.string().optional().describe('Filter by job number.'),
        vendorId: z.string().optional().describe('Filter by vendor Id.'),
        subcontractNumber: z.string().optional().describe('Filter by subcontract number.'),
        contractDateFrom: isoDate.optional().describe('Start of contract-date range.'),
        contractDateTo: isoDate.optional().describe('End of contract-date range.'),
        ...pageInput,
      }),
      output: z.object({
        count: z.number(),
        totalAmount: z.number(),
        subcontracts: z.array(
          z.object({
            subcontractId: z.string().nullable(),
            subcontractNumber: z.string().nullable(),
            jobNumber: z.string().nullable(),
            vendorCode: z.string().nullable(),
            description: z.string().nullable(),
            subcontractAmount: z.number().nullable(),
            holdbackPercent: z.number().nullable(),
            lines: z.array(
              z.object({
                line: z.number().nullable(),
                lineDescription: z.string().nullable(),
                quantity: z.number().nullable(),
                unitCost: z.number().nullable(),
                amount: z.number().nullable(),
                invoiceBalance: z.number().nullable(),
              }),
            ),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_subcontracts', { companyId: args.companyId, job: args.jobNumber });
        const rows = await jonasGet(
          '/api/Subcontract/GetSubcontracts',
          {
            companyId: args.companyId,
            jobId: args.jobId,
            jobNumber: args.jobNumber,
            vendorId: args.vendorId,
            subcontractNumber: args.subcontractNumber,
            contractDateFrom: args.contractDateFrom,
            contractDateTo: args.contractDateTo,
            pageNumber: args.page,
            pageSize: args.pageSize,
          },
          ctx,
        );
        const subcontracts = rows.map((r) => {
          const rawLines = Array.isArray(r.SubcontractLines) ? r.SubcontractLines : [];
          return {
            subcontractId: str(r, 'SubcontractId'),
            subcontractNumber: str(r, 'SubcontractNumber'),
            jobNumber: str(r, 'JobNumber'),
            vendorCode: str(r, 'VendorCode'),
            description: str(r, 'Description'),
            subcontractAmount: num(r, 'SubcontractAmount'),
            holdbackPercent: num(r, 'HoldbackPercent'),
            lines: rawLines
              .map((l) =>
                typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : {},
              )
              .map((l) => ({
                line: num(l, 'Line'),
                lineDescription: str(l, 'LineDescription'),
                quantity: num(l, 'Quantity'),
                unitCost: num(l, 'UnitCost'),
                amount: num(l, 'Amount'),
                invoiceBalance: num(l, 'InvoiceBalance'),
              })),
          };
        });
        const totalAmount = sum(subcontracts, 'subcontractAmount');
        if (subcontracts.length === 0) {
          return {
            text: 'No subcontracts matched.',
            structured: { count: 0, totalAmount: 0, subcontracts: [] },
          };
        }
        const lines = subcontracts
          .slice(0, 15)
          .map(
            (s) =>
              `  ${s.subcontractNumber ?? '?'} · ${s.vendorCode ?? '?'} — ` +
              `${fmt(s.subcontractAmount)}` +
              `${s.holdbackPercent !== null ? ` (holdback ${s.holdbackPercent}%)` : ''}` +
              `${s.jobNumber ? ` · job ${s.jobNumber}` : ''}`,
          )
          .join('\n');
        return {
          text:
            `${subcontracts.length} subcontract(s), page total ${fmt(totalAmount)}:\n${lines}` +
            (subcontracts.length > 15 ? `\n  … and ${subcontracts.length - 15} more` : ''),
          structured: { count: subcontracts.length, totalAmount, subcontracts },
        };
      },
    },
    {
      name: 'get_subcontract_change_orders',
      title: 'Premier: Get subcontract change orders',
      description:
        'List subcontract change orders (SCOs) for a company — SCO number, dates, status ' +
        '(Pending/Approved/Revising), scope, holdback %, and per-line amounts with a computed ' +
        'total per SCO. The approved-changes layer on top of get_subcontracts.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        companyId: uuid('Company Id (from list_companies).'),
        subcontractId: z.string().optional().describe('Filter by subcontract Id.'),
        subcontractNumber: z.string().optional().describe('Filter by subcontract number.'),
        jobId: z.string().optional().describe('Filter by job Id.'),
        jobNumber: z.string().optional().describe('Filter by job number.'),
        vendorId: z.string().optional().describe('Filter by vendor Id.'),
        scoNumber: z.string().optional().describe('Filter by SCO number.'),
        status: z
          .enum(['Pending', 'Approved', 'Revising'])
          .default('Approved')
          .describe('SCO status filter (default Approved).'),
        approvedDateFrom: isoDate.optional().describe('Start of approved-date range.'),
        approvedDateTo: isoDate.optional().describe('End of approved-date range.'),
      }),
      output: z.object({
        count: z.number(),
        totalAmount: z.number(),
        changeOrders: z.array(
          z.object({
            subChangeOrderId: z.string().nullable(),
            scoNumber: z.string().nullable(),
            subcontractNumber: z.string().nullable(),
            jobNumber: z.string().nullable(),
            vendorCode: z.string().nullable(),
            scoDate: z.string().nullable(),
            approvedDate: z.string().nullable(),
            description: z.string().nullable(),
            scoStatus: z.string().nullable(),
            holdbackPercent: z.number().nullable(),
            amount: z.number(),
            lines: z.array(
              z.object({
                line: z.number().nullable(),
                lineDescription: z.string().nullable(),
                quantity: z.number().nullable(),
                unitCost: z.number().nullable(),
                amount: z.number().nullable(),
                invoiceBalance: z.number().nullable(),
              }),
            ),
          }),
        ),
      }),
      async handler(args, ctx) {
        ctx.log('get_subcontract_change_orders', {
          companyId: args.companyId,
          subcontract: args.subcontractNumber,
        });
        const rows = await jonasGet(
          '/api/Subcontract/GetSubcontractChangeOrders',
          {
            companyId: args.companyId,
            subcontractId: args.subcontractId,
            subcontractNumber: args.subcontractNumber,
            jobId: args.jobId,
            jobNumber: args.jobNumber,
            vendorId: args.vendorId,
            sCONumber: args.scoNumber,
            status: args.status,
            approvedDateFrom: args.approvedDateFrom,
            approvedDateTo: args.approvedDateTo,
          },
          ctx,
        );
        const changeOrders = rows.map((r) => {
          const rawLines = Array.isArray(r.SubChangeOrderLines) ? r.SubChangeOrderLines : [];
          const lines = rawLines
            .map((l) => (typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : {}))
            .map((l) => ({
              line: num(l, 'Line'),
              lineDescription: str(l, 'LineDescription'),
              quantity: num(l, 'Quantity'),
              unitCost: num(l, 'UnitCost'),
              amount: num(l, 'Amount'),
              invoiceBalance: num(l, 'InvoiceBalance'),
            }));
          return {
            subChangeOrderId: str(r, 'SubChangeOrderId'),
            scoNumber: str(r, 'SCONumber'),
            subcontractNumber: str(r, 'SubcontractNumber'),
            jobNumber: str(r, 'JobNumber'),
            vendorCode: str(r, 'VendorCode'),
            scoDate: str(r, 'SCODate'),
            approvedDate: str(r, 'ApprovedDate'),
            description: str(r, 'Description'),
            scoStatus: str(r, 'SCOStatus'),
            holdbackPercent: num(r, 'HoldbackPercent'),
            amount: sum(lines, 'amount'),
            lines,
          };
        });
        const totalAmount = sum(changeOrders, 'amount');
        if (changeOrders.length === 0) {
          return {
            text: 'No subcontract change orders matched.',
            structured: { count: 0, totalAmount: 0, changeOrders: [] },
          };
        }
        const lines = changeOrders
          .slice(0, 15)
          .map(
            (c) =>
              `  SCO ${c.scoNumber ?? '?'} on ${c.subcontractNumber ?? '?'} — ${fmt(c.amount)} ` +
              `[${c.scoStatus ?? '?'}]${c.jobNumber ? ` · job ${c.jobNumber}` : ''}`,
          )
          .join('\n');
        return {
          text:
            `${changeOrders.length} change order(s), total ${fmt(totalAmount)}:\n${lines}` +
            (changeOrders.length > 15 ? `\n  … and ${changeOrders.length - 15} more` : ''),
          structured: { count: changeOrders.length, totalAmount, changeOrders },
        };
      },
    },
  ],
});
