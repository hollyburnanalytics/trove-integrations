import { defineToolkit } from '@ontrove/extend/toolkit';
import { GRAPH_VERSION } from './client.ts';
import { comparePeriods } from './tools/compare-periods.ts';
import { getInsights } from './tools/get-insights.ts';
import { listAdAccounts } from './tools/list-ad-accounts.ts';
import { listEntities } from './tools/list-entities.ts';

/**
 * Meta Ads — a hosted, read-only MCP server over the official Meta Marketing
 * API (graph.facebook.com), pinned to a Graph version. Four surfaces:
 *
 *  - `list_ad_accounts` — which ad accounts the token reaches (and whether the
 *                         token works at all),
 *  - `list_entities`    — campaigns/ad sets/ads with status, objective, budget
 *                         and schedule: the structure behind the numbers,
 *  - `get_insights`     — spend, delivery, cost and attributed conversions at
 *                         account/campaign/adset/ad level, over a window,
 *                         optionally as a time series and cut by breakdowns,
 *  - `compare_periods`  — the same query over two windows, joined and ranked by
 *                         what moved.
 *
 * Auth is one long-lived credential: `META_ACCESS_TOKEN`, a user or system-user
 * token carrying the **`ads_read`** permission, redeemed per invocation via
 * `ctx.requireSecret` and attached as a Bearer header (never placed in a URL).
 * `META_APP_SECRET` is optional and only needed by apps that switched on
 * "Require app secret", where it becomes the `appsecret_proof` every call must
 * carry. Set the default account once in the toolkit's settings
 * (`default_ad_account_id`) and every tool can be called without it.
 *
 * Three properties of this API shape most of the code, and each is a way to be
 * confidently wrong rather than to fail:
 *
 * 1. **Absence is not zero.** Insights rows exist only for entities that
 *    DELIVERED in the window, so a paused campaign is missing rather than
 *    reported at zero — an empty answer means "nothing ran", not "nothing
 *    exists". Every empty result says so, and `list_entities` is the tool that
 *    can see what insights cannot.
 * 2. **Every number arrives as a string, and money has no currency on it.**
 *    `spend` is `"1234.56"` and a daily budget is `"5000"` in the account
 *    currency's minimum unit. Numbers are coerced, budgets converted, and the
 *    currency code printed next to every amount — an advertiser billed in CAD
 *    reading a bare `$` is wrong by a third.
 * 3. **The page is not the result set.** Graph pages everything and its
 *    `cursors.after` is present even on the last page, so `paging.next` is the
 *    only honest "there is more" signal; it drives an explicit `TRUNCATED:`
 *    line, and `include_totals` can put the page's spend next to the account's.
 *
 * Errors get the same treatment: Graph answers an expired token, a missing
 * Business Manager role, a rate limit and a mistyped field name all with HTTP
 * 400, so `errors.ts` maps the codes back to four different remedies rather
 * than telling everyone to check their credentials.
 */

export default defineToolkit({
  id: 'meta-ads',
  name: 'Meta Ads Performance',
  description:
    'Read Meta (Facebook/Instagram) ad performance from the official Marketing API: spend, ' +
    'impressions, clicks, CTR, CPC, CPM, reach and attributed conversions (purchases, leads, ' +
    'ROAS) at account, campaign, ad set or ad level; daily/weekly/monthly time series; ' +
    'breakdowns by age, gender, country, placement and device; campaign/ad set/ad listings ' +
    'with status, objective and budget; and period-over-period comparisons ranked by what ' +
    'moved. Requires a META_ACCESS_TOKEN secret — a user or system-user token with the ' +
    'ads_read permission (plus META_APP_SECRET only if the app requires appsecret_proof). ' +
    `Read-only; pinned to Graph API ${GRAPH_VERSION}. An independent client for the Meta ` +
    'Marketing API — not affiliated with, sponsored by, or endorsed by Meta.',
  icon: '📊',
  version: '1.0.0',
  secrets: ['META_ACCESS_TOKEN', 'META_APP_SECRET'],
  egress: ['graph.facebook.com'],
  scopes: [],
  visibility: 'public',
  config: {
    default_ad_account_id: {
      label: 'Default ad account',
      type: 'text',
      placeholder: 'act_1234567890',
      hint: 'Used when a tool is called without ad_account_id. Find it with list_ad_accounts.',
    },
  },
  tools: [listAdAccounts, listEntities, getInsights, comparePeriods],
});
