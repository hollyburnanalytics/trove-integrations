import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { fmt, num, pageInput, str, sum } from '../fields.ts';

/**
 * `get_job_estimate` — the original estimate (budget) lines for a job; pair with
 * `get_job_transactions` for budget-vs-actual.
 */
export const getJobEstimate: ToolDefinition = {
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
};
