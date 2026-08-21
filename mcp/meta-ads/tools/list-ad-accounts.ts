import { tool, z } from '@ontrove/extend/toolkit';
import { accountStatus } from '../account.ts';
import { graphGet, readPaging } from '../client.ts';
import { ACCOUNT_FIELDS, fromMinorUnits, money } from '../fields.ts';
import { rateLimitNote } from '../notes.ts';

/**
 * `list_ad_accounts` — which ad accounts this token can actually read, and
 * therefore also the answer to "is my token working?".
 *
 * Every other tool needs an ad account id, and the id shown in Ads Manager is
 * the one thing users reliably cannot find. This is the discovery step, and it
 * is deliberately the cheapest call in the toolkit.
 */
export const listAdAccounts = tool({
  name: 'list_ad_accounts',
  title: 'Meta Ads: List ad accounts',
  description:
    "List the Meta ad accounts the configured access token can read, with each one's id " +
    '(act_…), name, currency, time zone, status and lifetime amount spent. Start here to find ' +
    'the ad_account_id the other tools need, or to check that META_ACCESS_TOKEN works and has ' +
    'the ads_read permission. An account whose status is not ACTIVE explains an empty report ' +
    'better than any date range will.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50).describe('Accounts per page (1–200).'),
    after: z.string().optional().describe("Cursor from a previous call's next_cursor."),
  }),
  output: z.object({
    count: z.number(),
    accounts: z.array(
      z.object({
        id: z.string(),
        accountId: z.string().optional(),
        name: z.string().optional(),
        currency: z.string().optional(),
        timeZone: z.string().optional(),
        status: z.string().optional(),
        amountSpent: z.number().optional(),
      }),
    ),
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
    notes: z.array(z.string()),
  }),
  async handler(args, ctx) {
    const params = new URLSearchParams({
      fields: ACCOUNT_FIELDS,
      limit: String(args.limit),
    });
    if (args.after) params.set('after', args.after);

    const { body, rateLimit } = await graphGet(ctx, '/me/adaccounts', params);
    const raw = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    const accounts = raw.map((account) => {
      const currency = typeof account.currency === 'string' ? account.currency : undefined;
      const digits = typeof account.account_id === 'string' ? account.account_id : undefined;
      return {
        // `id` already carries the act_ prefix; `account_id` is the bare digits,
        // and mixing them up is the most common cause of "object does not exist".
        id: typeof account.id === 'string' ? account.id : `act_${digits ?? ''}`,
        accountId: digits,
        name: typeof account.name === 'string' ? account.name : undefined,
        currency,
        timeZone: typeof account.timezone_name === 'string' ? account.timezone_name : undefined,
        status: accountStatus(account.account_status),
        amountSpent: fromMinorUnits(account.amount_spent, currency),
      };
    });
    const paging = readPaging(body);
    const notes = [
      paging.hasMore
        ? `TRUNCATED: more accounts exist${paging.after ? ` — pass after: "${paging.after}"` : ''}.`
        : undefined,
      rateLimitNote(rateLimit),
    ].filter((note): note is string => note !== undefined);

    if (accounts.length === 0) {
      const empty =
        'This token reaches no ad accounts. It is valid, but its owner has no role on any ad ' +
        'account in Business Manager — or the token was issued without the ads_read permission.';
      return {
        text: [empty, ...notes].join('\n'),
        structured: { count: 0, accounts: [], truncated: false, notes: [empty, ...notes] },
      };
    }

    const lines = accounts.map(
      (account) =>
        `• ${account.name ?? '(unnamed)'} — ${account.id}` +
        ` · ${account.currency ?? '?'} · ${account.timeZone ?? '?'}` +
        ` · ${account.status ?? '?'}` +
        (account.amountSpent === undefined
          ? ''
          : ` · ${money(account.amountSpent, account.currency)} spent lifetime`),
    );
    return {
      text: [`${accounts.length} ad account(s):`, ...lines, ...notes].join('\n'),
      structured: {
        count: accounts.length,
        accounts,
        truncated: paging.hasMore,
        nextCursor: paging.after,
        notes,
      },
    };
  },
});
