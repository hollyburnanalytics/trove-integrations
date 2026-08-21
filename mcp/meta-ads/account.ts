import type { ToolContext } from '@ontrove/extend/toolkit';
import { graphGet } from './client.ts';

/**
 * The two things about an ad account that every other answer depends on: what
 * currency its numbers are in, and whether it is allowed to spend at all.
 */

/**
 * Meta's `account_status` integers.
 *
 * Worth translating rather than passing through, because the number is the
 * explanation for an empty report: an account sitting at 2 (disabled) or 3
 * (unsettled) returns no delivery for reasons that have nothing to do with the
 * date range the caller keeps widening.
 */
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
  201: 'ANY_ACTIVE',
  202: 'ANY_CLOSED',
};

/** Name an `account_status` code, falling back to the number itself. */
export function accountStatus(raw: unknown): string | undefined {
  if (typeof raw !== 'number') return undefined;
  return ACCOUNT_STATUS[raw] ?? `STATUS_${raw}`;
}

/**
 * The account's currency, for reading budgets and spend caps.
 *
 * A separate call, but a cheap and highly cacheable one: budgets come back in
 * the currency's minimum unit with no currency attached, so without this a
 * daily budget of "5000" cannot be printed as anything a person can check.
 */
export async function accountCurrency(
  ctx: ToolContext,
  accountId: string,
): Promise<string | undefined> {
  const { body } = await graphGet(
    ctx,
    `/${accountId}`,
    new URLSearchParams({ fields: 'currency' }),
  );
  return typeof body.currency === 'string' ? body.currency : undefined;
}
