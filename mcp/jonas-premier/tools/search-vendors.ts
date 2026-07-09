import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { pageInput, str, uuid } from '../fields.ts';

/**
 * `search_vendors` — vendors (subs & suppliers) in one company, yielding the
 * apSubledgerId the AP invoice/payment tools require.
 */
export const searchVendors: ToolDefinition = {
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
};
