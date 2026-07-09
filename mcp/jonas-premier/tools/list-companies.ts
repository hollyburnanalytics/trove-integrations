import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { boolish, pageInput, str } from '../fields.ts';

/**
 * `list_companies` — the companies in the Premier tenant, the entry point that
 * yields the companyId almost every other tool needs.
 */
export const listCompanies: ToolDefinition = {
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
};
