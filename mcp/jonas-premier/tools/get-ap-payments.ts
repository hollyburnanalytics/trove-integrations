import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { fmt, isoDate, num, pageInput, str, sum, uuid } from '../fields.ts';

/**
 * `get_ap_payments` — AP payments for a company + AP subledger; the "what went
 * out the door, when, and how" query.
 */
export const getApPayments: ToolDefinition = {
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
};
