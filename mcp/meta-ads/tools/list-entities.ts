import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { accountCurrency } from '../account.ts';
import { graphGet, objectId, readPaging, resolveAccountId } from '../client.ts';
import {
  checkStatuses,
  ENTITY_FIELDS,
  ENTITY_LEVELS,
  ENTITY_STATUSES,
  type EntityLevel,
  fromMinorUnits,
  money,
} from '../fields.ts';
import { rateLimitNote } from '../notes.ts';

/**
 * `list_entities` — the structure behind the numbers: campaigns, ad sets and
 * ads with their status, objective, budget and schedule.
 *
 * It exists because `get_insights` cannot answer "what is in this account".
 * Insights rows are emitted only for entities that DELIVERED in the window, so
 * a campaign that is paused, scheduled for next week, or rejected is invisible
 * there — and those are exactly the entities somebody asking "why did spend
 * drop" needs to see.
 */

/**
 * Choose the narrowest edge that answers the question.
 *
 * Asking `/{campaign_id}/adsets` is not an optimisation over filtering the
 * account edge — it is the difference between a documented parent edge and a
 * client-side scan of an account that may hold thousands of ad sets, only the
 * first page of which would come back.
 */
function edgeFor(
  level: EntityLevel,
  accountId: string,
  campaignId: string | undefined,
  adsetId: string | undefined,
): string {
  if (level === 'campaign') {
    if (campaignId || adsetId) {
      throw new ToolError(
        'campaign_id/adset_id narrow a search for ad sets or ads. For one campaign, call ' +
          'get_insights with campaign_ids, or list ad sets with level: "adset".',
        { retryable: false },
      );
    }
    return `/${accountId}/campaigns`;
  }
  if (level === 'adset') {
    if (adsetId) {
      throw new ToolError('adset_id narrows a search for ads, not for ad sets.', {
        retryable: false,
      });
    }
    return campaignId ? `/${objectId(campaignId, 'campaign_id')}/adsets` : `/${accountId}/adsets`;
  }
  if (adsetId) return `/${objectId(adsetId, 'adset_id')}/ads`;
  return campaignId ? `/${objectId(campaignId, 'campaign_id')}/ads` : `/${accountId}/ads`;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Map one campaign/ad set/ad, converting budgets out of minor units. */
function mapEntity(raw: Record<string, unknown>, currency: string | undefined) {
  return {
    id: str(raw.id) ?? '',
    name: str(raw.name),
    accountId: str(raw.account_id),
    status: str(raw.status),
    effectiveStatus: str(raw.effective_status),
    campaignId: str(raw.campaign_id),
    adsetId: str(raw.adset_id),
    objective: str(raw.objective),
    optimizationGoal: str(raw.optimization_goal),
    billingEvent: str(raw.billing_event),
    bidStrategy: str(raw.bid_strategy),
    dailyBudget: fromMinorUnits(raw.daily_budget, currency),
    lifetimeBudget: fromMinorUnits(raw.lifetime_budget, currency),
    budgetRemaining: fromMinorUnits(raw.budget_remaining, currency),
    // The raw minor-unit strings ride along: the conversion above assumes two
    // decimal places for every currency but the handful that have none, and a
    // reader who suspects it can check.
    dailyBudgetMinorUnits: str(raw.daily_budget),
    lifetimeBudgetMinorUnits: str(raw.lifetime_budget),
    startTime: str(raw.start_time),
    endTime: str(raw.end_time) ?? str(raw.stop_time),
    updatedTime: str(raw.updated_time),
    currency,
  };
}

type Entity = ReturnType<typeof mapEntity>;

/** Where an entity's budget lives: on itself, daily or lifetime, else on its parent. */
function budgetText(entity: Entity): string {
  if (entity.dailyBudget !== undefined) return `${money(entity.dailyBudget, entity.currency)}/day`;
  if (entity.lifetimeBudget !== undefined) {
    return `${money(entity.lifetimeBudget, entity.currency)} lifetime`;
  }
  return 'budget at parent';
}

/** One prose line per entity: what it is, whether it can spend, and its budget. */
function entityLine(entity: Entity): string {
  const budget = budgetText(entity);
  const goal = entity.objective ?? entity.optimizationGoal;
  const objective = goal ? ` · ${goal}` : '';
  const ends = entity.endTime ? ` · ends ${entity.endTime.slice(0, 10)}` : '';
  return (
    `• ${entity.name ?? '(unnamed)'} (${entity.id}) — ${entity.effectiveStatus ?? entity.status ?? '?'}` +
    ` · ${budget}${objective}${ends}`
  );
}

export const listEntities = tool({
  name: 'list_entities',
  title: 'Meta Ads: List campaigns, ad sets and ads',
  description:
    'List the campaigns, ad sets or ads in a Meta ad account with their delivery status, ' +
    'objective, bid strategy, budget and schedule. Use it to find ids for get_insights, and to ' +
    'see what get_insights cannot show: entities that did not deliver in a window are absent ' +
    'from insights entirely, so a paused, scheduled or rejected campaign only appears here. ' +
    'Filter by effective_status (ACTIVE, PAUSED, CAMPAIGN_PAUSED, WITH_ISSUES, DISAPPROVED…), ' +
    "and narrow to one parent with campaign_id or adset_id. Budgets are converted from Meta's " +
    'minor units into the account currency, with the raw values kept alongside.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    ad_account_id: z
      .string()
      .optional()
      .describe('Ad account, act_1234567890 or the bare digits. Defaults to the saved setting.'),
    level: z.enum(ENTITY_LEVELS).default('campaign').describe('What to list.'),
    campaign_id: z
      .string()
      .optional()
      .describe("List only this campaign's ad sets or ads (uses the campaign edge directly)."),
    adset_id: z.string().optional().describe("List only this ad set's ads."),
    effective_status: z
      .array(z.enum(ENTITY_STATUSES))
      .optional()
      .describe(
        "Keep only these delivery statuses. Omit for Meta's default (everything not deleted). " +
          'The vocabulary differs by level: review statuses (PENDING_REVIEW, DISAPPROVED, ' +
          'PREAPPROVED, PENDING_BILLING_INFO) exist per ad, CAMPAIGN_PAUSED from ad set down, ' +
          'ADSET_PAUSED per ad.',
      ),
    limit: z.number().int().min(1).max(200).default(50).describe('Rows per page (1–200).'),
    after: z.string().optional().describe("Cursor from a previous call's next_cursor."),
  }),
  output: z.object({
    accountId: z.string(),
    level: z.string(),
    count: z.number(),
    entities: z.array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        accountId: z.string().optional(),
        status: z.string().optional(),
        effectiveStatus: z.string().optional(),
        campaignId: z.string().optional(),
        adsetId: z.string().optional(),
        objective: z.string().optional(),
        optimizationGoal: z.string().optional(),
        billingEvent: z.string().optional(),
        bidStrategy: z.string().optional(),
        dailyBudget: z.number().optional(),
        lifetimeBudget: z.number().optional(),
        budgetRemaining: z.number().optional(),
        dailyBudgetMinorUnits: z.string().optional(),
        lifetimeBudgetMinorUnits: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        updatedTime: z.string().optional(),
        currency: z.string().optional(),
      }),
    ),
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
    notes: z.array(z.string()),
  }),
  async handler(args, ctx) {
    const accountId = resolveAccountId(ctx, args.ad_account_id);
    if (args.effective_status?.length) checkStatuses(args.level, args.effective_status);
    const path = edgeFor(args.level, accountId, args.campaign_id, args.adset_id);
    const params = new URLSearchParams({
      fields: ENTITY_FIELDS[args.level],
      limit: String(args.limit),
    });
    if (args.effective_status?.length) {
      params.set('effective_status', JSON.stringify(args.effective_status));
    }
    if (args.after) params.set('after', args.after);
    ctx.log('list_entities', { accountId, level: args.level, path });

    const { body, rateLimit } = await graphGet(ctx, path, params);
    const raw = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    const paging = readPaging(body);
    // The currency is fetched for the account these entities SAY they are in,
    // which a parent edge can make different from the one resolved above.
    const owner = str(raw[0]?.account_id);
    const owningAccount = owner === undefined ? accountId : `act_${owner}`;
    const currency = raw.length > 0 ? await accountCurrency(ctx, owningAccount) : undefined;
    const entities = raw.map((entity) => mapEntity(entity, currency));
    const cursorHint = paging.after ? ` — pass after: "${paging.after}"` : '';
    const notes = [
      owningAccount === accountId
        ? undefined
        : `These belong to ${owningAccount}, not the ${accountId} this call resolved — budgets ` +
          'are shown in ITS currency.',
      paging.hasMore
        ? `TRUNCATED: ${entities.length} shown and more exist${cursorHint}.`
        : undefined,
      rateLimitNote(rateLimit),
    ].filter((note): note is string => note !== undefined);

    const header =
      entities.length === 0
        ? `No ${args.level}s match in ${accountId}.`
        : `${entities.length} ${args.level}(s) in ${accountId}:`;
    return {
      text: [header, ...entities.map((entity) => entityLine(entity)), ...notes].join('\n'),
      structured: {
        accountId: owningAccount,
        level: args.level,
        count: entities.length,
        entities,
        truncated: paging.hasMore,
        nextCursor: paging.after,
        notes,
      },
    };
  },
});
