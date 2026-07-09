import { type ToolDefinition, z } from '@ontrove/mcp';
import { jonasGet } from '../client.ts';
import { boolish, pageInput, str, uuid } from '../fields.ts';

/**
 * `get_gl_accounts` — the chart-of-accounts lookup behind any GL-coded question.
 */
export const getGlAccounts: ToolDefinition = {
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
};
