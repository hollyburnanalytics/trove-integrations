import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { fmt, isoDate, num, str, sum, uuid } from '../fields.ts';

/**
 * `get_subcontract_change_orders` — subcontract change orders (SCOs) for a
 * company; the approved-changes layer on top of `get_subcontracts`.
 */
export const getSubcontractChangeOrders: ToolDefinition = {
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
};
