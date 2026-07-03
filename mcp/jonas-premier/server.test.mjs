import { beforeEach, describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server, { __resetTokenCache } from './server.ts';

/**
 * Acceptance suite for the jonas-premier server. Premier sits behind an OAuth2
 * *password* grant (`POST /Authenticate`, form-encoded, fixed client id
 * `Premier.ExternalAPI`), hand-rolled in the server with a per-user token
 * cache — so beyond the usual per-tool mapping tests this suite exercises the
 * whole auth lifecycle: secret resolution, mint body shape, token reuse,
 * 401 re-mint, and credential failure modes. The server's module-scope cache
 * survives across `callTool` invocations; `__resetTokenCache()` in beforeEach
 * keeps tests order-independent.
 */

const SECRETS = {
  JONAS_USERNAME: 'api.user@builder.example',
  JONAS_PASSWORD: 'premier-api-pass',
};

/**
 * Build a responder that answers the SDK secret callback (per secret name),
 * the `/Authenticate` mint, and delegates everything else to `apiResponder`.
 * `overrides.auth` replaces the mint reply (a spec, or `(mintCount, init) => spec`);
 * `overrides.secrets` replaces the secret map. Call counts are exposed on
 * `responder.counters` so tests can assert mint/API traffic.
 */
function upstream(apiResponder, overrides = {}) {
  const counters = { mints: 0, api: 0, mintInits: [] };
  const secrets = overrides.secrets ?? SECRETS;
  const responder = (url, init) => {
    if (url.includes('/internal/secret')) {
      const { name } = JSON.parse(init.body);
      return { json: { value: secrets[name] ?? '' } };
    }
    if (url.includes('/Authenticate')) {
      counters.mints += 1;
      counters.mintInits.push(init);
      if (overrides.auth) {
        return typeof overrides.auth === 'function'
          ? overrides.auth(counters.mints, init)
          : overrides.auth;
      }
      return { json: { access_token: `token-${counters.mints}`, expires_in: 3600 } };
    }
    counters.api += 1;
    return typeof apiResponder === 'function' ? apiResponder(url, init, counters) : apiResponder;
  };
  responder.counters = counters;
  return responder;
}

/** Wrap rows in Premier's `{ Data, Message, Code }` envelope. */
const envelope = (data) => ({
  json: { Data: data, Message: '', Details: [], Code: 'OK', Summary: '' },
});

// --- Fixtures shaped after the vendor's published swagger models ---

const COMPANY = {
  CompanyId: 'c0000000-0000-0000-0000-000000000001',
  CompanyCode: 'NGB',
  CompanyName: 'Northgate Builders Ltd.',
  BusinessNumber: '123456789RC0001',
  City: 'North Vancouver',
  Active: true,
};

const JOB = {
  JobId: 'j0000000-0000-0000-0000-000000000001',
  JobNumber: '24-105',
  JobName: 'Lions Gate Mixed-Use',
  JobStatus: 'Active',
  Active: true,
  City: 'North Vancouver',
  ZipCode: 'V7P 3P9',
};

const TXN = {
  JobNumber: '24-105',
  JobName: 'Lions Gate Mixed-Use',
  CostItemCode: '03-100',
  CostItemDescription: 'Concrete Formwork',
  CostTypeCode: 'SUB',
  TransactionType: 'AP Invoice',
  TransactionDate: '2026-05-14T00:00:00',
  TransactionRefNumber: 'INV-4411',
  LineDescription: 'Formwork progress draw 3',
  VendorName: 'Coastal Formworks Ltd.',
  PONumber: '',
  SubcontractNumber: 'SC-024',
  Qty: 1,
  UnitCost: 84_250.5,
  Cost: 84_250.5,
};

const ESTIMATE_LINE = {
  JobNumber: '24-105',
  JobName: 'Lions Gate Mixed-Use',
  CostItemCode: '03-100',
  CostItemDescription: 'Concrete Formwork',
  CostTypeCode: 'SUB',
  OriginalEstimateLineDescription: 'Formwork carve-out',
  Qty: 1,
  UnitCost: 400_000,
  Cost: 400_000,
  Revenue: 480_000,
  VendorName: 'Coastal Formworks Ltd.',
};

const VENDOR = {
  VendorId: 'v0000000-0000-0000-0000-000000000001',
  APSubledgerId: 'a0000000-0000-0000-0000-000000000001',
  VendorCode: 'COAST01',
  VendorName: 'Coastal Formworks Ltd.',
  BusinessNumber: '987654321RC0001',
  City: 'Burnaby',
  Email: 'ap@coastalformworks.example',
  Phone1: '604-555-0199',
};

const INVOICE = {
  InvoiceId: 'i0000000-0000-0000-0000-000000000001',
  VendorCode: 'COAST01',
  VendorName: 'Coastal Formworks Ltd.',
  InvoiceNumber: 'INV-4411',
  InvoiceDate: '2026-05-10T00:00:00',
  DueDate: '2026-06-09T00:00:00',
  TransactionDate: '2026-05-14T00:00:00',
  JobNumber: '24-105',
  SubcontractNumber: 'SC-024',
  PurchaseOrderNumber: '',
  SubTotal: 80_238.57,
  TotalTax: 4011.93,
  InvoiceTotal: 84_250.5,
  InvoiceStatus: 'O/S',
  ApprovalStatus: 'Approved',
};

const PAYMENT = {
  PaymentId: 'p0000000-0000-0000-0000-000000000001',
  VendorCode: 'COAST01',
  VendorName: 'Coastal Formworks Ltd.',
  Payee: 'Coastal Formworks Ltd.',
  PaymentNumber: 'EFT-2201',
  Amount: 75_825.45,
  PaymentDate: '2026-06-05T00:00:00',
  PaymentMethod: 'EFT',
  Memo: 'Draw 3 less 10% holdback',
  Status: 'Cleared',
};

const ACCOUNT = {
  AccountId: 'g0000000-0000-0000-0000-000000000001',
  AccountNumber: '2110',
  AccountName: 'Holdbacks Payable',
  AccountType: 'Liability',
  StatementType: 'BS',
  Currency: 'CAD',
  HasSubAccounts: 'False',
  Active: 'True',
};

const SUBCONTRACT = {
  SubcontractId: 's0000000-0000-0000-0000-000000000001',
  SubcontractNumber: 'SC-024',
  JobNumber: '24-105',
  VendorCode: 'COAST01',
  Description: 'Concrete formwork supply & install',
  SubcontractAmount: 400_000,
  HoldbackPercent: 10,
  SubcontractLines: [
    {
      Line: 1,
      LineDescription: 'Formwork – towers',
      Quantity: 1,
      UnitCost: 400_000,
      Amount: 400_000,
      InvoiceBalance: 315_749.5,
    },
  ],
};

const SCO = {
  SubChangeOrderId: 'o0000000-0000-0000-0000-000000000001',
  SCONumber: 'SCO-003',
  SubcontractNumber: 'SC-024',
  JobNumber: '24-105',
  VendorCode: 'COAST01',
  SCODate: '2026-04-01T00:00:00',
  ApprovedDate: '2026-04-12T00:00:00',
  Description: 'Added parkade shear walls',
  SCOStatus: 'Approved',
  HoldbackPercent: 10,
  SubChangeOrderLines: [
    {
      Line: 1,
      LineDescription: 'Shear walls P1–P3',
      Quantity: 1,
      UnitCost: 42_000,
      Amount: 42_000,
      InvoiceBalance: 42_000,
    },
    {
      Line: 2,
      LineDescription: 'Rebar adjustment',
      Quantity: 1,
      UnitCost: 3500,
      Amount: 3500,
      InvoiceBalance: 3500,
    },
  ],
};

const COMPANY_ID = COMPANY.CompanyId;
const SUBLEDGER_ID = VENDOR.APSubledgerId;

beforeEach(() => {
  __resetTokenCache();
});

describe('jonas-premier MCP server', () => {
  it('lists the ten read-only tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_ap_invoices',
      'get_ap_payments',
      'get_gl_accounts',
      'get_job_estimate',
      'get_job_transactions',
      'get_subcontract_change_orders',
      'get_subcontracts',
      'list_companies',
      'search_jobs',
      'search_vendors',
    ]);
  });

  it('marks every tool read-only', () => {
    for (const tool of server.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  describe('authentication', () => {
    it('mints via a form-encoded password grant with the fixed client id', async () => {
      const responder = upstream(envelope([COMPANY]));
      const result = await callTool(server, 'list_companies', {}, responder);
      expect(result.ok).toBe(true);
      expect(responder.counters.mints).toBe(1);
      const init = responder.counters.mintInits[0];
      expect(init.method).toBe('POST');
      const contentType = new Headers(init.headers).get('content-type');
      expect(contentType).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body);
      expect(form.get('grant_type')).toBe('password');
      expect(form.get('client_id')).toBe('Premier.ExternalAPI');
      expect(form.get('username')).toBe(SECRETS.JONAS_USERNAME);
      expect(form.get('password')).toBe(SECRETS.JONAS_PASSWORD);
    });

    it('attaches the minted bearer to the API request', async () => {
      let auth = '';
      const responder = upstream((_url, init) => {
        auth = new Headers(init.headers).get('authorization') ?? '';
        return envelope([COMPANY]);
      });
      await callTool(server, 'list_companies', {}, responder);
      expect(auth).toBe('Bearer token-1');
    });

    it('reuses the cached token across calls (one mint, two API hits)', async () => {
      const responder = upstream(envelope([COMPANY]));
      await callTool(server, 'list_companies', {}, responder);
      await callTool(server, 'list_companies', {}, responder);
      expect(responder.counters.mints).toBe(1);
      expect(responder.counters.api).toBe(2);
    });

    it('re-mints once on an API 401 and retries with the fresh token', async () => {
      const seen = [];
      const responder = upstream((_url, init, counters) => {
        seen.push(new Headers(init.headers).get('authorization'));
        if (counters.api === 1) return { status: 401, text: 'expired' };
        return envelope([COMPANY]);
      });
      const result = await callTool(server, 'list_companies', {}, responder);
      expect(result.ok).toBe(true);
      expect(responder.counters.mints).toBe(2);
      expect(seen).toEqual(['Bearer token-1', 'Bearer token-2']);
    });

    it('reports a persistent 401 as a clear non-retryable permission error', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream({ status: 401, text: 'nope' }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/re-authenticating|permission|revoked/i);
    });

    it('fails clearly when a secret is unset, without touching the API', async () => {
      const responder = upstream(envelope([COMPANY]), {
        secrets: { JONAS_USERNAME: 'someone', JONAS_PASSWORD: '' },
      });
      const result = await callTool(server, 'list_companies', {}, responder);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/JONAS_PASSWORD/);
      expect(responder.counters.api).toBe(0);
    });

    it('maps a rejected grant (400) to a non-retryable credentials error', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream(envelope([COMPANY]), {
          auth: { status: 400, json: { error: 'invalid_grant' } },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/credentials|API user/i);
    });

    it('maps an auth-endpoint 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream(envelope([COMPANY]), { auth: { status: 500, text: 'oops' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('treats a token response without access_token as retryable', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream(envelope([COMPANY]), { auth: { json: { token_type: 'bearer' } } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/no access token/i);
    });

    it('treats malformed auth JSON as retryable', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream(envelope([COMPANY]), { auth: { text: '<html>gateway</html>' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });

  describe('envelope & error mapping', () => {
    it('surfaces an envelope-level error Message as a non-retryable error', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream({
          text: '{"Data":null,"Message":"Company access denied for this API user","Code":"Error"}',
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/Company access denied/);
    });

    it('treats a null-Data, no-Message envelope as an empty result', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream({ text: '{"Data":null,"Message":"","Code":"OK"}' }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
    });

    it('maps an HTTP 400 to a non-retryable error carrying Premier’s reason', async () => {
      const result = await callTool(
        server,
        'search_jobs',
        { companyId: COMPANY_ID },
        upstream({ status: 400, json: { Message: 'Invalid Company Id' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/Invalid Company Id/);
    });

    it('maps 429 and 500 to retryable errors', async () => {
      const throttled = await callTool(
        server,
        'list_companies',
        {},
        upstream({ status: 429, text: 'slow down' }),
      );
      expect(throttled.ok).toBe(false);
      expect(throttled.retryable).toBe(true);

      __resetTokenCache();
      const broken = await callTool(
        server,
        'list_companies',
        {},
        upstream({ status: 500, text: 'boom' }),
      );
      expect(broken.ok).toBe(false);
      expect(broken.retryable).toBe(true);
    });

    it('treats a malformed API body as retryable', async () => {
      const result = await callTool(
        server,
        'list_companies',
        {},
        upstream({ text: 'not json at all' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });

  describe('list_companies', () => {
    it('maps companies and pagination params', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'list_companies',
        { search: 'northgate', status: 'All', page: 2, pageSize: 100 },
        upstream((url) => {
          requested = url;
          return envelope([COMPANY]);
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.count).toBe(1);
      expect(s.companies[0]).toEqual({
        companyId: COMPANY_ID,
        companyCode: 'NGB',
        companyName: 'Northgate Builders Ltd.',
        businessNumber: '123456789RC0001',
        city: 'North Vancouver',
        active: true,
      });
      expect(result.result.text).toContain('Northgate Builders');
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/api/Company/GetCompanies');
      expect(decoded).toContain('parameter.search=northgate');
      expect(decoded).toContain('parameter.status=All');
      expect(decoded).toContain('parameter.pageNumber=2');
      expect(decoded).toContain('parameter.pageSize=100');
    });
  });

  describe('search_jobs', () => {
    it('maps jobs and requires companyId', async () => {
      const result = await callTool(
        server,
        'search_jobs',
        { companyId: COMPANY_ID, search: 'lions' },
        upstream(envelope([JOB])),
      );
      expect(result.ok).toBe(true);
      const job = result.result.structured.jobs[0];
      expect(job.jobId).toBe(JOB.JobId);
      expect(job.jobNumber).toBe('24-105');
      expect(job.jobName).toBe('Lions Gate Mixed-Use');
      expect(job.jobStatus).toBe('Active');
      expect(job.zipCode).toBe('V7P 3P9');

      const missing = await callTool(server, 'search_jobs', { search: 'lions' });
      expect(missing.ok).toBe(false);
      expect(missing.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_job_transactions', () => {
    it('maps ledger lines, sums the page, and forces the Normal view', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'get_job_transactions',
        {
          company: 'NGB',
          job: '24-105',
          costOrRevenue: 'All',
          updatedFrom: '2026-05-01',
          updatedTo: '2026-05-31',
        },
        upstream((url) => {
          requested = url;
          return envelope([TXN, { ...TXN, Cost: 1000.25, TransactionRefNumber: 'INV-4412' }]);
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.count).toBe(2);
      expect(s.totalCost).toBeCloseTo(85_250.75, 2);
      expect(s.transactions[0]).toMatchObject({
        jobNumber: '24-105',
        costItemCode: '03-100',
        costTypeCode: 'SUB',
        transactionType: 'AP Invoice',
        transactionRefNumber: 'INV-4411',
        vendorName: 'Coastal Formworks Ltd.',
        subcontractNumber: 'SC-024',
        cost: 84_250.5,
      });
      expect(s.transactions[0].poNumber).toBeNull();
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/api/Job/GetJobTransactions');
      expect(decoded).toContain('parameter.company=NGB');
      expect(decoded).toContain('parameter.job=24-105');
      expect(decoded).toContain('parameter.costOrRevenue=All');
      expect(decoded).toContain('parameter.updatedFrom=2026-05-01');
      expect(decoded).toContain('parameter.updatedTo=2026-05-31');
      expect(decoded).toContain('parameter.view=Normal');
    });

    it('requires the updated-date range and validates its format', async () => {
      const missing = await callTool(server, 'get_job_transactions', { company: 'NGB' });
      expect(missing.ok).toBe(false);
      expect(missing.code).toBe('INVALID_PARAMS');

      const malformed = await callTool(server, 'get_job_transactions', {
        company: 'NGB',
        updatedFrom: 'May 1st',
        updatedTo: '2026-05-31',
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_job_estimate', () => {
    it('maps estimate lines with cost and revenue totals', async () => {
      const result = await callTool(
        server,
        'get_job_estimate',
        { company: 'NGB', job: '24-105' },
        upstream(envelope([ESTIMATE_LINE])),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.totalCost).toBe(400_000);
      expect(s.totalRevenue).toBe(480_000);
      expect(s.estimateLines[0]).toMatchObject({
        costItemCode: '03-100',
        lineDescription: 'Formwork carve-out',
        cost: 400_000,
        revenue: 480_000,
      });
    });
  });

  describe('search_vendors', () => {
    it('returns the apSubledgerId the AP tools depend on', async () => {
      const result = await callTool(
        server,
        'search_vendors',
        { companyId: COMPANY_ID, vendorName: 'Coastal' },
        upstream(envelope([VENDOR])),
      );
      expect(result.ok).toBe(true);
      const v = result.result.structured.vendors[0];
      expect(v.vendorId).toBe(VENDOR.VendorId);
      expect(v.apSubledgerId).toBe(SUBLEDGER_ID);
      expect(v.vendorCode).toBe('COAST01');
      expect(v.email).toBe('ap@coastalformworks.example');
    });
  });

  describe('get_ap_invoices', () => {
    it('maps invoices, totals the page, and encodes the O/S status filter', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'get_ap_invoices',
        {
          companyId: COMPANY_ID,
          apSubledgerId: SUBLEDGER_ID,
          status: 'O/S',
          transactionDateFrom: '2026-05-01',
          transactionDateTo: '2026-05-31',
        },
        upstream((url) => {
          requested = url;
          return envelope([INVOICE]);
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.totalAmount).toBeCloseTo(84_250.5, 2);
      expect(s.invoices[0]).toMatchObject({
        invoiceNumber: 'INV-4411',
        vendorName: 'Coastal Formworks Ltd.',
        jobNumber: '24-105',
        subcontractNumber: 'SC-024',
        subTotal: 80_238.57,
        totalTax: 4011.93,
        invoiceTotal: 84_250.5,
        invoiceStatus: 'O/S',
        approvalStatus: 'Approved',
      });
      expect(s.invoices[0].purchaseOrderNumber).toBeNull();
      expect(requested).toContain('/api/APInvoice/GetInvoices');
      expect(requested).toContain(`parameter.aPSubledgerId=${SUBLEDGER_ID}`);
      expect(requested).toContain('parameter.status=O%2FS');
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('parameter.transactionDateFrom=2026-05-01');
      expect(decoded).toContain('parameter.transactionDateTo=2026-05-31');
    });

    it('requires the AP subledger id before fetching', async () => {
      const result = await callTool(server, 'get_ap_invoices', { companyId: COMPANY_ID });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_ap_payments', () => {
    it('maps payments and encodes includeCancelled as yes/no', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'get_ap_payments',
        {
          companyId: COMPANY_ID,
          apSubledgerId: SUBLEDGER_ID,
          includeCancelled: true,
          paymentDateFrom: '2026-06-01',
          paymentDateTo: '2026-06-30',
        },
        upstream((url) => {
          requested = url;
          return envelope([PAYMENT]);
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.totalAmount).toBeCloseTo(75_825.45, 2);
      expect(s.payments[0]).toMatchObject({
        paymentNumber: 'EFT-2201',
        payee: 'Coastal Formworks Ltd.',
        amount: 75_825.45,
        paymentMethod: 'EFT',
        memo: 'Draw 3 less 10% holdback',
        status: 'Cleared',
      });
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/api/APPayment/GetPayments');
      expect(decoded).toContain('parameter.includeCancelled=yes');

      __resetTokenCache();
      await callTool(
        server,
        'get_ap_payments',
        { companyId: COMPANY_ID, apSubledgerId: SUBLEDGER_ID },
        upstream((url) => {
          requested = url;
          return envelope([]);
        }),
      );
      expect(decodeURIComponent(requested)).toContain('parameter.includeCancelled=no');
    });
  });

  describe('get_gl_accounts', () => {
    it('maps accounts, decoding Premier’s "True"/"False" strings to booleans', async () => {
      const result = await callTool(
        server,
        'get_gl_accounts',
        { companyId: COMPANY_ID, search: 'holdback' },
        upstream(envelope([ACCOUNT])),
      );
      expect(result.ok).toBe(true);
      const a = result.result.structured.accounts[0];
      expect(a).toEqual({
        accountId: ACCOUNT.AccountId,
        accountNumber: '2110',
        accountName: 'Holdbacks Payable',
        accountType: 'Liability',
        statementType: 'BS',
        currency: 'CAD',
        hasSubAccounts: false,
        active: true,
      });
    });
  });

  describe('get_subcontracts', () => {
    it('maps commitments with holdback and nested lines', async () => {
      const result = await callTool(
        server,
        'get_subcontracts',
        { companyId: COMPANY_ID, jobNumber: '24-105' },
        upstream(envelope([SUBCONTRACT])),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.totalAmount).toBe(400_000);
      const sc = s.subcontracts[0];
      expect(sc.subcontractNumber).toBe('SC-024');
      expect(sc.subcontractAmount).toBe(400_000);
      expect(sc.holdbackPercent).toBe(10);
      expect(sc.lines).toHaveLength(1);
      expect(sc.lines[0]).toMatchObject({
        lineDescription: 'Formwork – towers',
        amount: 400_000,
        invoiceBalance: 315_749.5,
      });
      expect(result.result.text).toContain('holdback 10%');
    });
  });

  describe('get_subcontract_change_orders', () => {
    it('maps SCOs, sums line amounts per SCO, and passes the status filter', async () => {
      let requested = '';
      const result = await callTool(
        server,
        'get_subcontract_change_orders',
        { companyId: COMPANY_ID, subcontractNumber: 'SC-024', status: 'Pending' },
        upstream((url) => {
          requested = url;
          return envelope([SCO]);
        }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.count).toBe(1);
      expect(s.totalAmount).toBe(45_500);
      const co = s.changeOrders[0];
      expect(co.scoNumber).toBe('SCO-003');
      expect(co.amount).toBe(45_500);
      expect(co.lines).toHaveLength(2);
      expect(co.scoStatus).toBe('Approved');
      const decoded = decodeURIComponent(requested);
      expect(decoded).toContain('/api/Subcontract/GetSubcontractChangeOrders');
      expect(decoded).toContain('parameter.subcontractNumber=SC-024');
      expect(decoded).toContain('parameter.status=Pending');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'get_subcontract_change_orders',
        { companyId: COMPANY_ID },
        upstream(envelope([])),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no subcontract change orders/i);
    });
  });
});
