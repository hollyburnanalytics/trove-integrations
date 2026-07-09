import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { fmt, isoDate, num, pageInput, str, sum, uuid } from '../fields.ts';

/**
 * `get_subcontracts` — subcontract commitments for a company; the committed-cost
 * side of budget-vs-committed-vs-actual.
 */
export const getSubcontracts: ToolDefinition = {
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
          .map((l) => (typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : {}))
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
};
