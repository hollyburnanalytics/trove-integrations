import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { fmt, isoDate, num, pageInput, str, sum } from '../fields.ts';

/**
 * `get_job_transactions` — job-cost ledger lines (actuals) for a company over a
 * required updated-date range; the core "what did we actually spend on job X".
 */
export const getJobTransactions: ToolDefinition = {
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
};
