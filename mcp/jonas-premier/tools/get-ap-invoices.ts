import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { fmt, isoDate, num, pageInput, str, sum, uuid } from '../fields.ts';

/**
 * `get_ap_invoices` — AP invoices for a company + AP subledger; the "what do we
 * owe, and on which job" query.
 */
export const getApInvoices: ToolDefinition = {
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
};
