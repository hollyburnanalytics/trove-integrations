import { describe, expect, it } from 'vitest';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const TOKEN = 'EAAtest_token';
// Named for what it is to the test — an HMAC key — so the secret-scanner rule
// does not read a fixture as a leaked credential.
const PROOF_KEY = 'meta-ads-test-hmac-key';
const PROOF_VECTOR = 'b58bf07f8f8c172c403970e57eb934b0c655eb34b542a383d96f8f8b33cb12e2';

/**
 * Reply to the SDK secret callback per NAME, so the optional META_APP_SECRET can
 * be present in one test and absent in the next — `{value: null}` is the
 * platform's "declared, not set", which is the normal state for that one.
 */
function withSecrets(values, responder) {
  return (url, init) => {
    if (url.includes('/internal/secret')) {
      const { name } = JSON.parse(init.body);
      return { json: { value: values[name] ?? null } };
    }
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
}

/** The usual case: a token, no app secret. */
const authed = (responder) => withSecrets({ META_ACCESS_TOKEN: TOKEN }, responder);

/** Query parameters of a Graph URL. */
const query = (url) => new URL(url).searchParams;

/** A campaign-level insights row as Meta actually sends one: every value a string. */
const campaignRow = (over = {}) => ({
  account_id: '1234567890',
  account_currency: 'CAD',
  campaign_id: '23851',
  campaign_name: 'Prospecting — Video',
  objective: 'OUTCOME_SALES',
  impressions: '145300',
  clicks: '2410',
  spend: '1204.55',
  ctr: '1.658',
  cpc: '0.4998',
  cpm: '8.2903',
  reach: '98211',
  frequency: '1.4795',
  actions: [
    { action_type: 'link_click', value: '2280' },
    { action_type: 'omni_purchase', value: '61' },
  ],
  action_values: [{ action_type: 'omni_purchase', value: '5310.20' }],
  purchase_roas: [{ action_type: 'omni_purchase', value: '4.4085' }],
  date_start: '2026-07-21',
  date_stop: '2026-08-19',
  ...over,
});

describe('meta-ads MCP server', () => {
  it('exposes four read-only tools', () => {
    expect(server.tools.map((tool) => tool.name).toSorted()).toEqual([
      'compare_periods',
      'get_insights',
      'list_ad_accounts',
      'list_entities',
    ]);
    expect(server.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('auth and transport', () => {
    it('sends the token as a Bearer header and never in the URL', async () => {
      let seen;
      const result = await callTool(
        server,
        'list_ad_accounts',
        {},
        authed((url, init) => {
          seen = { url, headers: new Headers(init?.headers) };
          return { json: { data: [] } };
        }),
      );
      expect(result.ok).toBe(true);
      expect(seen.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      // A token in a query string ends up in logs, caches and error messages.
      expect(seen.url).not.toContain(TOKEN);
      expect(seen.url).toContain('/v26.0/me/adaccounts');
    });

    it('adds appsecret_proof only when META_APP_SECRET is set, and computes it right', async () => {
      let withProof;
      await callTool(
        server,
        'list_ad_accounts',
        { limit: 7 },
        withSecrets({ META_ACCESS_TOKEN: TOKEN, META_APP_SECRET: PROOF_KEY }, (url) => {
          withProof = query(url).get('appsecret_proof');
          return { json: { data: [] } };
        }),
      );
      // An independently computed vector, not a re-run of the implementation:
      // HMAC-SHA256(key = PROOF_KEY, message = TOKEN), hex. Meta rejects every
      // call from a proof-required app if this is wrong, so it is worth pinning.
      expect(withProof).toBe(PROOF_VECTOR);

      let withoutProof = 'unset';
      await callTool(
        server,
        'list_ad_accounts',
        { limit: 8 },
        authed((url) => {
          withoutProof = query(url).get('appsecret_proof');
          return { json: { data: [] } };
        }),
      );
      expect(withoutProof).toBeNull();
    });

    it("keeps one tenant's answer out of another's, despite an identical URL", async () => {
      const forUser = (name) =>
        callTool(
          server,
          'list_ad_accounts',
          { limit: 11 },
          authed({ json: { data: [{ id: `act_${name}`, name, currency: 'USD' }] } }),
          [],
          name,
        );
      const first = await forUser('user-a');
      const second = await forUser('user-b');
      expect(first.result.structured.accounts[0].id).toBe('act_user-a');
      // The response cache is module scope and keyed on the URL; without the
      // per-caller salt this would still say user-a.
      expect(second.result.structured.accounts[0].id).toBe('act_user-b');
    });
  });

  describe('list_ad_accounts', () => {
    it('maps accounts and converts lifetime spend out of minor units', async () => {
      const result = await callTool(
        server,
        'list_ad_accounts',
        { limit: 3 },
        authed({
          json: {
            data: [
              {
                id: 'act_1234567890',
                account_id: '1234567890',
                name: 'Hollyburn — Main',
                currency: 'CAD',
                timezone_name: 'America/Vancouver',
                account_status: 1,
                amount_spent: '1204550',
              },
              {
                id: 'act_222',
                account_id: '222',
                name: 'Tokyo',
                currency: 'JPY',
                account_status: 2,
                amount_spent: '500000',
              },
            ],
          },
        }),
      );
      const [main, tokyo] = result.result.structured.accounts;
      expect(main).toMatchObject({ id: 'act_1234567890', currency: 'CAD', status: 'ACTIVE' });
      expect(main.amountSpent).toBeCloseTo(12_045.5, 2);
      // A yen account reports whole yen: dividing by 100 would understate it 100×.
      expect(tokyo.amountSpent).toBe(500_000);
      expect(tokyo.status).toBe('DISABLED');
      expect(result.result.text).toContain('CAD 12,045.50 spent lifetime');
    });

    it('says a valid token with no accounts is a permissions story, not an outage', async () => {
      const result = await callTool(
        server,
        'list_ad_accounts',
        { limit: 4 },
        authed({ json: { data: [] } }),
      );
      expect(result.result.text).toContain('no ad accounts');
      expect(result.result.text).toContain('ads_read');
    });

    it('reports truncation from paging.next, not from the cursor', async () => {
      const withNext = await callTool(
        server,
        'list_ad_accounts',
        { limit: 1 },
        authed({
          json: {
            data: [{ id: 'act_1', name: 'One', currency: 'USD' }],
            paging: { cursors: { after: 'CUR2' }, next: 'https://graph.facebook.com/next' },
          },
        }),
      );
      expect(withNext.result.structured).toMatchObject({ truncated: true, nextCursor: 'CUR2' });

      const lastPage = await callTool(
        server,
        'list_ad_accounts',
        { limit: 2 },
        authed({
          // Meta sends `cursors.after` on the LAST page too; treating it as
          // "more available" invents a page that does not exist.
          json: { data: [{ id: 'act_1', name: 'One' }], paging: { cursors: { after: 'CUR2' } } },
        }),
      );
      expect(lastPage.result.structured.truncated).toBe(false);
      expect(lastPage.result.structured.nextCursor).toBeUndefined();
    });
  });

  describe('get_insights', () => {
    it('asks for identity + metric fields and matches Ads Manager attribution', async () => {
      let asked;
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000001', level: 'campaign' },
        authed((url) => {
          asked = query(url);
          return { json: { data: [campaignRow()] } };
        }),
      );
      expect(result.ok).toBe(true);
      const fields = asked.get('fields').split(',');
      expect(fields).toContain('campaign_name');
      expect(fields).toContain('spend');
      expect(fields).toContain('purchase_roas');
      expect(asked.get('level')).toBe('campaign');
      expect(asked.get('date_preset')).toBe('last_30d');
      expect(asked.get('time_increment')).toBe('all_days');
      // Without this the tool's conversion counts disagree with Ads Manager for
      // the same campaign over the same dates.
      expect(asked.get('use_unified_attribution_setting')).toBe('true');
    });

    it('types the strings, names the currency, and finds purchases under omni_purchase', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000002' },
        authed({ json: { data: [campaignRow()] } }),
      );
      const [row] = result.result.structured.rows;
      expect(row.metrics.spend).toBe(1204.55);
      expect(row.metrics.impressions).toBe(145_300);
      expect(row.actions.omni_purchase).toBe(61);
      expect(row.purchaseRoas).toBeCloseTo(4.4085, 4);
      expect(row.name).toBe('Prospecting — Video');
      // The currency CODE, never a bare $: this account bills in CAD.
      expect(result.result.text).toContain('CAD 1,204.55');
      expect(result.result.text).toContain('61 purchases worth CAD 5,310.20');
      expect(result.result.structured.totals.spend).toBe(1204.55);
    });

    it('recomputes blended rates from totals instead of averaging rows', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000003' },
        authed({
          json: {
            data: [
              campaignRow({
                campaign_id: 'a',
                impressions: '1000000',
                clicks: '10000',
                spend: '100',
                ctr: '1.0',
              }),
              campaignRow({
                campaign_id: 'b',
                impressions: '10',
                clicks: '5',
                spend: '1',
                ctr: '50.0',
              }),
            ],
          },
        }),
      );
      const { totals } = result.result.structured;
      // The mean of 1.0% and 50.0% is 25.5%. The truth is ~1.0%.
      expect(totals.ctr).toBeCloseTo((10_005 / 1_000_010) * 100, 6);
      expect(totals.cpc).toBeCloseTo(101 / 10_005, 6);
      // Reach is de-duplicated people and is deliberately NOT summed.
      expect(totals.reach).toBeUndefined();
    });

    it('explains an empty result as "nothing delivered", not as zero spend', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000004', date_preset: 'last_7d' },
        authed({ json: { data: [] } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).toContain('absent rather than zero');
      expect(result.result.text).toContain('list_entities');
      expect(result.result.structured.count).toBe(0);
    });

    it('sends an explicit range as time_range and refuses the ways it can be wrong', async () => {
      let asked;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000005', since: '2026-08-01', until: '2026-08-14' },
        authed((url) => {
          asked = query(url);
          return { json: { data: [] } };
        }),
      );
      expect(JSON.parse(asked.get('time_range'))).toEqual({
        since: '2026-08-01',
        until: '2026-08-14',
      });
      expect(asked.get('date_preset')).toBeNull();

      const both = await callTool(server, 'get_insights', {
        ad_account_id: '1000000005',
        date_preset: 'last_7d',
        since: '2026-08-01',
        until: '2026-08-14',
      });
      expect(both.ok).toBe(false);
      expect(both.error).toContain('silently ignores the preset');

      const half = await callTool(server, 'get_insights', {
        ad_account_id: '1000000005',
        since: '2026-08-01',
      });
      expect(half.ok).toBe(false);
      expect(half.error).toContain('go together');

      // Meta answers a reversed range with an empty 200, which reads as "no spend".
      const reversed = await callTool(server, 'get_insights', {
        ad_account_id: '1000000005',
        since: '2026-08-14',
        until: '2026-08-01',
      });
      expect(reversed.ok).toBe(false);
      expect(reversed.error).toContain('reversed range');

      const tooOld = await callTool(server, 'get_insights', {
        ad_account_id: '1000000005',
        since: '2019-01-01',
        until: '2019-02-01',
      });
      expect(tooOld.ok).toBe(false);
      expect(tooOld.error).toContain('37 months');
    });

    it('turns daily into time_increment=1 and dates every row', async () => {
      let asked;
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000006', time_increment: 'daily' },
        authed((url) => {
          asked = query(url);
          return {
            json: {
              data: [
                campaignRow({ date_start: '2026-08-01', date_stop: '2026-08-01' }),
                campaignRow({ date_start: '2026-08-02', date_stop: '2026-08-02' }),
              ],
            },
          };
        }),
      );
      expect(asked.get('time_increment')).toBe('1');
      // Without the date in the label, a 30-day series reads as 30 copies of
      // the same campaign.
      expect(result.result.text).toContain('2026-08-01');
      expect(result.result.text).toContain('2026-08-02');
    });

    it('passes breakdowns through and labels each row with its slice', async () => {
      let asked;
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000007', breakdowns: ['age', 'gender'] },
        authed((url) => {
          asked = query(url);
          return {
            json: { data: [campaignRow({ age: '25-34', gender: 'female' })] },
          };
        }),
      );
      expect(asked.get('breakdowns')).toBe('age,gender');
      const [row] = result.result.structured.rows;
      expect(row.breakdowns).toEqual({ age: '25-34', gender: 'female' });
      expect(result.result.text).toContain('25-34/female');
      // Breakdown values are dimensions, not metrics.
      expect(row.metrics.age).toBeUndefined();
    });

    it('refuses the ad-level quality metrics at campaign level, by name', async () => {
      const refused = await callTool(server, 'get_insights', {
        ad_account_id: '1000000008',
        level: 'campaign',
        metrics: ['core', 'quality'],
      });
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain('quality_ranking');
      expect(refused.error).toContain('level: "ad"');

      let asked;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000008', level: 'ad', metrics: ['quality'] },
        authed((url) => {
          asked = query(url);
          return { json: { data: [] } };
        }),
      );
      expect(asked.get('fields')).toContain('quality_ranking');
    });

    it('says the page is not the answer, and can put it next to the account total', async () => {
      let asked;
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000009', limit: 1, include_totals: true },
        authed((url) => {
          asked = query(url);
          return {
            json: {
              data: [campaignRow()],
              summary: { spend: '9600.00', impressions: '1000000', clicks: '20000' },
              paging: { cursors: { after: 'NEXT1' }, next: 'https://graph.facebook.com/next' },
            },
          };
        }),
      );
      expect(asked.get('summary')).toBe('spend,impressions,clicks');
      expect(result.result.text).toContain('TRUNCATED');
      expect(result.result.text).toContain('12.5%');
      expect(result.result.structured.nextCursor).toBe('NEXT1');
      expect(result.result.structured.allRowsSummary.spend).toBe(9600);
    });

    it('checks the order Meta returned, and says so when it had to sort here', async () => {
      const rows = [
        campaignRow({ campaign_id: 'small', campaign_name: 'Small', spend: '10' }),
        campaignRow({ campaign_id: 'big', campaign_name: 'Big', spend: '900' }),
      ];
      const honoured = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000010', sort_by: 'spend' },
        authed({ json: { data: [rows[1], rows[0]] } }),
      );
      expect(honoured.result.structured.sortedLocally).toBe(false);

      const ignored = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000011', sort_by: 'spend' },
        authed({ json: { data: rows } }),
      );
      expect(ignored.result.structured.sortedLocally).toBe(true);
      expect(ignored.result.structured.rows[0].name).toBe('Big');
      // An unsorted "top spenders" list that LOOKS ranked is worse than one
      // that admits it only ranked the page.
      expect(ignored.result.text).toContain('this page only');
    });

    it('narrows to specific campaigns with a filtering clause', async () => {
      let asked;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000012', campaign_ids: ['23851', '23852'] },
        authed((url) => {
          asked = query(url);
          return { json: { data: [] } };
        }),
      );
      expect(JSON.parse(asked.get('filtering'))).toEqual([
        { field: 'campaign.id', operator: 'IN', value: ['23851', '23852'] },
      ]);
    });

    it('swaps the unified setting for explicit windows, and warns that they differ', async () => {
      let asked;
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000013', attribution_windows: ['1d_click', '7d_click'] },
        authed((url) => {
          asked = query(url);
          return { json: { data: [campaignRow()] } };
        }),
      );
      expect(asked.get('action_attribution_windows')).toBe('1d_click,7d_click');
      expect(asked.get('use_unified_attribution_setting')).toBeNull();
      expect(result.result.text).toContain('differ');
    });

    it('surfaces how much of the rate-limit budget the account has spent', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000014' },
        authed(() => ({
          json: { data: [campaignRow()] },
          headers: {
            'x-fb-ads-insights-throttle':
              '{"app_id_util_pct":12.0,"acc_id_util_pct":91.5,"ads_api_access_tier":"standard_access"}',
          },
        })),
      );
      expect(result.result.text).toContain('RATE LIMIT WARNING');
      expect(result.result.text).toContain('account 92%');
      expect(result.result.structured.notes.join(' ')).toContain('standard_access');
    });
  });

  describe('ad account ids', () => {
    it('accepts bare digits, refuses anything else, and falls back to the setting', async () => {
      let path;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '1000000015' },
        authed((url) => {
          path = new URL(url).pathname;
          return { json: { data: [] } };
        }),
      );
      expect(path).toBe('/v26.0/act_1000000015/insights');

      const wrong = await callTool(server, 'get_insights', { ad_account_id: 'my-business' });
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toContain('act_1234567890');

      const missing = await callTool(server, 'get_insights', {});
      expect(missing.ok).toBe(false);
      expect(missing.error).toContain('list_ad_accounts');
    });
  });

  describe('error mapping', () => {
    const graphError = (error) => ({ status: 400, json: { error } });

    const call = (accountId, error) =>
      callTool(server, 'get_insights', { ad_account_id: accountId }, authed(graphError(error)));

    it('separates an expired token from a missing role', async () => {
      const expired = await call('2000000001', {
        message: 'Error validating access token: Session has expired',
        code: 190,
      });
      expect(expired.ok).toBe(false);
      expect(expired.retryable).toBe(false);
      expect(expired.error).toContain('META_ACCESS_TOKEN');

      const forbidden = await call('2000000002', {
        message: 'Ad account owner has NOT grant ads_management permission',
        code: 200,
      });
      expect(forbidden.error).toContain('Business Manager');
      expect(forbidden.error).not.toContain('expired');
    });

    it('treats the rate-limit families as retryable, whatever number they wear', async () => {
      for (const code of [4, 17, 613, 80_004]) {
        const limited = await call(`200000${code}`, { message: 'limit reached', code });
        expect(limited.ok).toBe(false);
        expect(limited.retryable).toBe(true);
        expect(limited.error).toContain('rate-limiting');
      }
    });

    it('turns "too much data" into an instruction, not a credentials hunt', async () => {
      const tooBig = await call('2000000003', {
        message: 'Please reduce the amount of data',
        code: 100,
        error_subcode: 1_487_534,
      });
      expect(tooBig.error).toContain('Narrow the date range');
      expect(tooBig.retryable).toBe(false);
    });

    it('prefers the user-facing sentence and keeps other 100s as caller errors', async () => {
      const badField = await call('2000000004', {
        message: '(#100) param fields must be an array',
        error_user_msg: 'The field "spendz" is not valid.',
        code: 100,
      });
      expect(badField.error).toContain('spendz');
      expect(badField.retryable).toBe(false);
    });

    it("treats Meta's own transient codes as retryable", async () => {
      const blip = await call('2000000005', { message: 'An unknown error occurred', code: 1 });
      expect(blip.retryable).toBe(true);
    });

    it('does not blame the caller for a body that is not JSON', async () => {
      const html = await callTool(
        server,
        'get_insights',
        { ad_account_id: '2000000006' },
        authed({ status: 200, text: '<html>maintenance</html>' }),
      );
      expect(html.ok).toBe(false);
      expect(html.retryable).toBe(true);
      expect(html.error).toContain('non-JSON');
    });
  });

  describe('list_entities', () => {
    const account = { json: { currency: 'CAD' } };
    const respond = (entities, over = {}) =>
      authed((url) => {
        if (new URL(url).pathname.endsWith('/act_3000000001')) return account;
        if (new URL(url).pathname.endsWith('/act_3000000002')) return { json: { currency: 'JPY' } };
        return { json: { data: entities, ...over } };
      });

    it('lists campaigns with budgets in real money and the raw minor units kept', async () => {
      const result = await callTool(
        server,
        'list_entities',
        { ad_account_id: '3000000001', level: 'campaign' },
        respond([
          {
            id: '23851',
            name: 'Prospecting — Video',
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            objective: 'OUTCOME_SALES',
            daily_budget: '5000',
            stop_time: '2026-09-30T00:00:00-0700',
          },
        ]),
      );
      const [campaign] = result.result.structured.entities;
      expect(campaign.dailyBudget).toBe(50);
      expect(campaign.dailyBudgetMinorUnits).toBe('5000');
      expect(campaign.currency).toBe('CAD');
      expect(result.result.text).toContain('CAD 50.00/day');
      expect(result.result.text).toContain('ends 2026-09-30');
    });

    it('keeps a yen budget in yen', async () => {
      const result = await callTool(
        server,
        'list_entities',
        { ad_account_id: '3000000002', level: 'campaign' },
        respond([{ id: '1', name: 'Tokyo', daily_budget: '5000' }]),
      );
      expect(result.result.structured.entities[0].dailyBudget).toBe(5000);
    });

    it('uses the parent edge when a parent is named, and filters on effective_status', async () => {
      const paths = [];
      const responder = authed((url) => {
        const { pathname, searchParams } = new URL(url);
        paths.push({ pathname, status: searchParams.get('effective_status') });
        return pathname.endsWith('/act_3000000003')
          ? { json: { currency: 'USD' } }
          : { json: { data: [] } };
      });
      await callTool(
        server,
        'list_entities',
        {
          ad_account_id: '3000000003',
          level: 'adset',
          campaign_id: '23851',
          effective_status: ['ACTIVE', 'CAMPAIGN_PAUSED'],
        },
        responder,
      );
      const edge = paths.find((entry) => entry.pathname.includes('adsets'));
      expect(edge.pathname).toBe('/v26.0/23851/adsets');
      expect(JSON.parse(edge.status)).toEqual(['ACTIVE', 'CAMPAIGN_PAUSED']);
    });

    it('refuses a parent filter that does not apply to what was asked for', async () => {
      const wrong = await callTool(server, 'list_entities', {
        ad_account_id: '3000000004',
        level: 'campaign',
        campaign_id: '23851',
      });
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toContain('get_insights');
    });
  });

  describe('compare_periods', () => {
    /** Answer each window from its own `time_range`. */
    const byWindow = (windows) =>
      authed((url) => {
        const range = query(url).get('time_range');
        return { json: { data: windows[range] ?? [] } };
      });

    it('derives an equal-length baseline immediately before the window', async () => {
      const seen = [];
      await callTool(
        server,
        'compare_periods',
        { ad_account_id: '4000000001', since: '2026-08-01', until: '2026-08-14' },
        authed((url) => {
          seen.push(JSON.parse(query(url).get('time_range')));
          return { json: { data: [] } };
        }),
      );
      expect(seen[0]).toEqual({ since: '2026-08-01', until: '2026-08-14' });
      // 14 days, ending the day before the current window starts.
      expect(seen[1]).toEqual({ since: '2026-07-18', until: '2026-07-31' });
    });

    it('offers the same calendar dates a year back, and says weekdays will not align', async () => {
      const seen = [];
      const result = await callTool(
        server,
        'compare_periods',
        {
          ad_account_id: '4000000002',
          since: '2026-08-01',
          until: '2026-08-31',
          compare_to: 'previous_year',
        },
        authed((url) => {
          seen.push(JSON.parse(query(url).get('time_range')));
          return { json: { data: [campaignRow()] } };
        }),
      );
      expect(seen[1]).toEqual({ since: '2025-08-01', until: '2025-08-31' });
      expect(result.result.text).toContain('weekday');
    });

    it('ranks by the size of the move and flags one-sided entities', async () => {
      const current = JSON.stringify({ since: '2026-08-01', until: '2026-08-07' });
      const baseline = JSON.stringify({ since: '2026-07-25', until: '2026-07-31' });
      const result = await callTool(
        server,
        'compare_periods',
        { ad_account_id: '4000000003', since: '2026-08-01', until: '2026-08-07' },
        byWindow({
          [current]: [
            campaignRow({ campaign_id: 'a', campaign_name: 'Steady', spend: '105', clicks: '210' }),
            campaignRow({
              campaign_id: 'c',
              campaign_name: 'Launched',
              spend: '400',
              clicks: '800',
            }),
          ],
          [baseline]: [
            campaignRow({ campaign_id: 'a', campaign_name: 'Steady', spend: '100', clicks: '200' }),
            campaignRow({ campaign_id: 'b', campaign_name: 'Switched off', spend: '250' }),
          ],
        }),
      );
      const { rows, totals } = result.result.structured;
      expect(rows.map((row) => row.name)).toEqual(['Launched', 'Switched off', 'Steady']);
      expect(rows[0].presence).toBe('new');
      expect(rows[1].presence).toBe('stopped');
      // A campaign that did not exist before did not grow by 100%.
      expect(rows[0].spend.changePct).toBeUndefined();
      expect(rows[2].spend.changePct).toBeCloseTo(5, 6);
      expect(totals.spend.before).toBe(350);
      expect(totals.spend.after).toBe(505);
      expect(result.result.text).toContain('[NEW]');
      expect(result.result.text).toContain('[STOPPED]');
    });

    it('warns that a truncated comparison compares only the top spenders', async () => {
      const result = await callTool(
        server,
        'compare_periods',
        { ad_account_id: '4000000004', since: '2026-08-01', until: '2026-08-07', limit: 1 },
        authed({
          json: {
            data: [campaignRow()],
            paging: { cursors: { after: 'X' }, next: 'https://graph.facebook.com/next' },
          },
        }),
      );
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.text).toContain('top spenders only');
    });

    it('requires both explicit baseline bounds together', async () => {
      const half = await callTool(server, 'compare_periods', {
        ad_account_id: '4000000005',
        since: '2026-08-01',
        until: '2026-08-07',
        baseline_since: '2026-01-01',
      });
      expect(half.ok).toBe(false);
      expect(half.error).toContain('go together');
    });
  });
  describe('shapes Meta only sends sometimes', () => {
    it('reports an ad-level row by its ad, sums video milestones, keeps rankings as labels', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000000001', level: 'ad', metrics: ['core', 'video', 'quality'] },
        authed({
          json: {
            data: [
              {
                account_currency: 'USD',
                campaign_id: '1',
                campaign_name: 'C',
                adset_id: '2',
                adset_name: 'S',
                ad_id: '3',
                ad_name: 'Hook A',
                spend: '12.30',
                impressions: '4000',
                // Video milestones arrive as action lists, one entry per type.
                video_p25_watched_actions: [
                  { action_type: 'video_view', value: '900' },
                  { action_type: 'video_view_organic', value: '100' },
                ],
                quality_ranking: 'ABOVE_AVERAGE',
                attribution_setting: '7d_click_1d_view',
              },
            ],
          },
        }),
      );
      const [row] = result.result.structured.rows;
      expect(row.id).toBe('3');
      expect(row.name).toBe('Hook A');
      expect(row.metrics.video_p25_watched_actions).toBe(1000);
      expect(row.labels.quality_ranking).toBe('ABOVE_AVERAGE');
      expect(row.attributionSetting).toBe('7d_click_1d_view');
      expect(result.result.text).toContain('Hook A (3)');
    });

    it('finds purchases under the plain action type when omni_purchase is absent', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000000002' },
        authed({
          json: {
            data: [
              campaignRow({
                actions: [{ action_type: 'purchase', value: '4' }],
                action_values: [{ action_type: 'purchase', value: '99.50' }],
                purchase_roas: undefined,
              }),
            ],
          },
        }),
      );
      expect(result.result.structured.rows[0].actions.purchase).toBe(4);
      expect(result.result.text).toContain('4 purchases worth CAD 99.50');
      // No ROAS was reported, so none is printed.
      expect(result.result.text).not.toContain('× ROAS');
    });

    it('prints n/a rather than a zero for a metric Meta did not send', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000000003', level: 'account' },
        authed({
          json: { data: [{ account_id: '5000000003', account_name: 'Acct', impressions: '10' }] },
        }),
      );
      expect(result.result.text).toContain('n/a');
      expect(result.result.structured.rows[0].metrics.spend).toBeUndefined();
    });

    it('warns before a row explosion it was asked for', async () => {
      const result = await callTool(
        server,
        'get_insights',
        {
          ad_account_id: '5000000004',
          level: 'ad',
          time_increment: 'daily',
          breakdowns: ['age', 'gender'],
        },
        authed({ json: { data: [campaignRow()] } }),
      );
      expect(result.result.text).toContain('Row count multiplies');
    });

    it('names the remaining Graph refusals by their remedy', async () => {
      const call = (accountId, error) =>
        callTool(
          server,
          'get_insights',
          { ad_account_id: accountId },
          authed({ status: 400, json: { error } }),
        );

      const old = await call('5000001001', { message: 'Start date is too far', code: 3018 });
      expect(old.error).toContain('37 months');

      const dead = await call('5000001002', { message: 'deprecated', code: 2635 });
      expect(dead.error).toContain('pins its version');

      const gone = await call('5000001003', { message: 'does not exist', code: 803 });
      expect(gone.error).toContain('Check the ad account');

      const silent = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000001004' },
        authed({ status: 400, text: 'nope' }),
      );
      expect(silent.error).toContain('HTTP 400');
      expect(silent.retryable).toBe(false);
    });

    it('reports an unknown account_status rather than dropping it', async () => {
      const result = await callTool(
        server,
        'list_ad_accounts',
        { limit: 12 },
        authed({ json: { data: [{ id: 'act_9', account_status: 42 }, { id: 'act_10' }] } }),
      );
      const [odd, none] = result.result.structured.accounts;
      expect(odd.status).toBe('STATUS_42');
      expect(none.status).toBeUndefined();
    });

    it('lists the ads under one ad set, and says when a budget lives at the parent', async () => {
      const paths = [];
      const result = await callTool(
        server,
        'list_entities',
        { ad_account_id: '5000000005', level: 'ad', adset_id: '77' },
        authed((url) => {
          const { pathname } = new URL(url);
          paths.push(pathname);
          return pathname.endsWith('/act_5000000005')
            ? { json: { currency: 'USD' } }
            : { json: { data: [{ id: '9', name: 'Ad One', effective_status: 'ACTIVE' }] } };
        }),
      );
      expect(paths).toContain('/v26.0/77/ads');
      expect(result.result.text).toContain('budget at parent');
    });

    it('says plainly when nothing matches a listing', async () => {
      const result = await callTool(
        server,
        'list_entities',
        { ad_account_id: '5000000006', level: 'campaign' },
        authed((url) =>
          new URL(url).pathname.endsWith('/act_5000000006')
            ? { json: { currency: 'USD' } }
            : { json: { data: [] } },
        ),
      );
      expect(result.result.text).toContain('No campaigns match');
      expect(result.result.structured.count).toBe(0);
    });
    it('reports a hard block with the minutes Meta says it will last', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000000007' },
        authed(() => ({
          json: { data: [campaignRow()] },
          headers: {
            'x-business-use-case-usage':
              '{"1234567890":[{"type":"ads_insights","call_count":100,"estimated_time_to_regain_access":12}]}',
          },
        })),
      );
      expect(result.result.text).toContain('RATE LIMITED');
      expect(result.result.text).toContain('12 minute(s)');
    });

    it('ignores a rate-limit header it cannot parse instead of failing the call', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000000008' },
        authed(() => ({
          json: { data: [campaignRow()] },
          headers: { 'x-fb-ads-insights-throttle': 'not json at all' },
        })),
      );
      expect(result.ok).toBe(true);
      expect(result.result.text).not.toContain('Rate limit');
    });

    it('rejects a JSON body that is not an object', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '5000000009' },
        authed({ status: 200, text: '"just a string"' }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('malformed');
    });

    it('refuses an adset_id when ad sets are what was asked for', async () => {
      const wrong = await callTool(server, 'list_entities', {
        ad_account_id: '5000000010',
        level: 'adset',
        adset_id: '77',
      });
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toContain('narrows a search for ads');
    });
  });
  describe("checked against Meta's own generated SDK (v26.0)", () => {
    it("reads one campaign from the campaign's own insights edge, with no filter", async () => {
      let seen;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '6000000001', campaign_ids: ['23851'], level: 'adset' },
        authed((url) => {
          seen = { path: new URL(url).pathname, filtering: query(url).get('filtering') };
          return { json: { data: [] } };
        }),
      );
      // The campaign/adset/ad objects each expose the same 23-parameter
      // insights edge, so the single-entity case never needs `filtering`.
      expect(seen.path).toBe('/v26.0/23851/insights');
      expect(seen.filtering).toBeNull();
    });

    it('falls back to the account edge when one edge cannot express the request', async () => {
      let seen;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '6000000002', campaign_ids: ['1'], ad_ids: ['9', '10'] },
        authed((url) => {
          seen = { path: new URL(url).pathname, filtering: query(url).get('filtering') };
          return { json: { data: [] } };
        }),
      );
      expect(seen.path).toBe('/v26.0/act_6000000002/insights');
      expect(JSON.parse(seen.filtering)).toEqual([
        { field: 'ad.id', operator: 'IN', value: ['9', '10'] },
        { field: 'campaign.id', operator: 'IN', value: ['1'] },
      ]);
    });

    it('asks for the SDK-confirmed metrics that are not in `actions`', async () => {
      let fields;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '6000000003', metrics: ['core', 'conversions', 'video'] },
        authed((url) => {
          fields = query(url).get('fields').split(',');
          return { json: { data: [] } };
        }),
      );
      // cost per 1,000 PEOPLE, next to cpm's cost per 1,000 impressions.
      expect(fields).toContain('cpp');
      // Custom conversions are not a subset of the standard action types.
      expect(fields).toContain('conversions');
      expect(fields).toContain('cost_per_conversion');
      expect(fields).toContain('video_avg_time_watched_actions');
    });

    it('passes action_report_time through and warns it will not match Ads Manager', async () => {
      let asked;
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '6000000004', action_report_time: 'conversion' },
        authed((url) => {
          asked = query(url);
          return { json: { data: [campaignRow()] } };
        }),
      );
      expect(asked.get('action_report_time')).toBe('conversion');
      expect(result.result.text).toContain('not by impression time');
    });

    it('accepts data_maximum, which is not the same window as maximum', async () => {
      let asked;
      await callTool(
        server,
        'get_insights',
        { ad_account_id: '6000000005', date_preset: 'data_maximum' },
        authed((url) => {
          asked = query(url);
          return { json: { data: [] } };
        }),
      );
      expect(asked.get('date_preset')).toBe('data_maximum');
    });

    it('totals a repeated action type instead of keeping the last slice', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '6000000006' },
        authed({
          json: {
            data: [
              campaignRow({
                actions: [
                  { action_type: 'omni_purchase', value: '40' },
                  { action_type: 'omni_purchase', value: '21' },
                ],
              }),
            ],
          },
        }),
      );
      // Last-one-wins would report 21 of 61 purchases as the whole.
      expect(result.result.structured.rows[0].actions.omni_purchase).toBe(61);
    });

    it('will not call a campaign NEW when the window it is missing from was truncated', async () => {
      const current = JSON.stringify({ since: '2026-08-01', until: '2026-08-07' });
      const baseline = JSON.stringify({ since: '2026-07-25', until: '2026-07-31' });
      const result = await callTool(
        server,
        'compare_periods',
        { ad_account_id: '6000000007', since: '2026-08-01', until: '2026-08-07', limit: 1 },
        authed((url) => {
          const range = query(url).get('time_range');
          if (range === current) {
            return { json: { data: [campaignRow({ campaign_id: 'x', campaign_name: 'Riser' })] } };
          }
          return {
            json: {
              // The baseline page is full and Meta says there is more, so a
              // campaign absent from it may just have ranked below the cutoff.
              data: [campaignRow({ campaign_id: 'y', campaign_name: 'Other' })],
              [range === baseline ? 'paging' : 'unused']: {
                cursors: { after: 'C' },
                next: 'https://graph.facebook.com/next',
              },
            },
          };
        }),
      );
      const riser = result.result.structured.rows.find((row) => row.name === 'Riser');
      expect(riser.presence).toBe('unpaired');
      expect(result.result.text).toContain('[UNPAIRED]');
      expect(result.result.text).toContain('below the cutoff');
    });

    it('still calls it NEW when the baseline window was complete', async () => {
      const current = JSON.stringify({ since: '2026-08-01', until: '2026-08-07' });
      const result = await callTool(
        server,
        'compare_periods',
        { ad_account_id: '6000000008', since: '2026-08-01', until: '2026-08-07' },
        authed((url) =>
          query(url).get('time_range') === current
            ? { json: { data: [campaignRow({ campaign_id: 'x', campaign_name: 'Riser' })] } }
            : { json: { data: [] } },
        ),
      );
      expect(result.result.structured.rows[0].presence).toBe('new');
    });
  });
  describe('what the SDK audit found in review', () => {
    it('refuses an ad-level delivery status at campaign level, and names the valid ones', async () => {
      // Meta's EffectiveStatus enums differ by level: 6 values for a campaign,
      // 7 for an ad set, 12 for an ad. Review is an ad-level concept.
      const wrong = await callTool(server, 'list_entities', {
        ad_account_id: '7000000001',
        level: 'campaign',
        effective_status: ['ACTIVE', 'DISAPPROVED'],
      });
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toContain('DISAPPROVED is not a campaign status');
      expect(wrong.error).toContain('level: "ad"');

      const okAtAdLevel = await callTool(
        server,
        'list_entities',
        { ad_account_id: '7000000001', level: 'ad', effective_status: ['DISAPPROVED'] },
        authed((url) =>
          new URL(url).pathname.endsWith('/act_7000000001')
            ? { json: { currency: 'USD' } }
            : { json: { data: [] } },
        ),
      );
      expect(okAtAdLevel.ok).toBe(true);
    });

    it('keeps costs and averages per type instead of adding them together', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '7000000002' },
        authed({
          json: {
            data: [
              campaignRow({
                cost_per_action_type: [
                  { action_type: 'omni_purchase', value: '19.75' },
                  { action_type: 'lead', value: '4.10' },
                ],
                cost_per_conversion: [
                  { action_type: 'omni_purchase', value: '19.75' },
                  { action_type: 'lead', value: '4.10' },
                ],
                // Same wire shape as a video milestone count, and yet a sum of
                // it would be a duration nobody watched.
                video_avg_time_watched_actions: [
                  { action_type: 'video_view', value: '7' },
                  { action_type: 'video_view_organic', value: '3' },
                ],
              }),
            ],
          },
        }),
      );
      const [row] = result.result.structured.rows;
      expect(row.costPerAction).toEqual({ omni_purchase: 19.75, lead: 4.1 });
      expect(row.costPerConversion).toEqual({ omni_purchase: 19.75, lead: 4.1 });
      // 19.75 + 4.10 is not the cost of anything.
      expect(row.metrics.cost_per_conversion).toBeUndefined();
      expect(row.rates.video_avg_time_watched_actions).toEqual({
        video_view: 7,
        video_view_organic: 3,
      });
      expect(row.metrics.video_avg_time_watched_actions).toBeUndefined();
    });

    it('still gives a single-type ratio as a scalar, so it stays printable', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '7000000003' },
        authed({
          json: {
            data: [
              campaignRow({
                video_avg_time_watched_actions: [{ action_type: 'video_view', value: '9' }],
              }),
            ],
          },
        }),
      );
      const [row] = result.result.structured.rows;
      expect(row.metrics.video_avg_time_watched_actions).toBe(9);
      expect(row.rates.video_avg_time_watched_actions).toEqual({ video_view: 9 });
    });

    it('never adds two ROAS ratios together', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '7000000004' },
        authed({
          json: {
            data: [
              campaignRow({
                purchase_roas: [
                  { action_type: 'omni_purchase', value: '4.40' },
                  { action_type: 'omni_purchase', value: '2.10' },
                ],
              }),
            ],
          },
        }),
      );
      // 6.5× would be a fabricated return on ad spend.
      expect(result.result.structured.rows[0].purchaseRoas).toBe(4.4);
    });

    it('counts, however, do add up across repeated slices', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '7000000005' },
        authed({
          json: {
            data: [
              campaignRow({
                video_p25_watched_actions: [
                  { action_type: 'video_view', value: '900' },
                  { action_type: 'video_view_organic', value: '100' },
                ],
              }),
            ],
          },
        }),
      );
      expect(result.result.structured.rows[0].metrics.video_p25_watched_actions).toBe(1000);
    });

    it('refuses an entity id that is not an id, before it reaches a URL path', async () => {
      // These ids are interpolated into `/{id}/insights`, so a non-id is not a
      // failed lookup — it is a redirect of an authenticated call.
      const injected = await callTool(server, 'get_insights', {
        ad_account_id: '7000000006',
        campaign_ids: ['me/adaccounts?x='],
      });
      expect(injected.ok).toBe(false);
      expect(injected.error).toContain('is not a Meta object id');

      const viaListing = await callTool(server, 'list_entities', {
        ad_account_id: '7000000006',
        level: 'ad',
        adset_id: '../../me',
      });
      expect(viaListing.ok).toBe(false);
      expect(viaListing.error).toContain('is not a Meta object id');
    });

    it('reports the account the rows actually came from', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '7000000007', campaign_ids: ['23851'] },
        authed({
          json: {
            // An entity id is not scoped to the account we resolved: this
            // campaign belongs to a different account the token also reaches.
            data: [campaignRow({ account_id: '9999999999', account_currency: 'GBP' })],
          },
        }),
      );
      expect(result.result.structured.accountId).toBe('act_9999999999');
      expect(result.result.text).toContain('not the act_7000000007 this call resolved');
      expect(result.result.text).toContain('GBP');
    });
  });
  describe('second review pass', () => {
    it('sums a count list but never a CTR list, though Meta types them alike', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '8000000001', metrics: ['core', 'engagement'] },
        authed({
          json: {
            data: [
              campaignRow({
                outbound_clicks: [
                  { action_type: 'outbound_click', value: '800' },
                  { action_type: 'link_click', value: '200' },
                ],
                // Same list<AdsActionStats> shape, and percentages: adding
                // 1.2% to 0.4% describes nothing.
                outbound_clicks_ctr: [
                  { action_type: 'outbound_click', value: '1.2' },
                  { action_type: 'link_click', value: '0.4' },
                ],
              }),
            ],
          },
        }),
      );
      const [row] = result.result.structured.rows;
      expect(row.metrics.outbound_clicks).toBe(1000);
      expect(row.metrics.outbound_clicks_ctr).toBeUndefined();
      expect(row.rates.outbound_clicks_ctr).toEqual({ outbound_click: 1.2, link_click: 0.4 });
    });

    it('treats an unrecognised list as a map, because guessing wrong invents a number', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '8000000002', extra_fields: ['some_future_ratio'] },
        authed({
          json: {
            data: [
              campaignRow({
                some_future_ratio: [
                  { action_type: 'a', value: '3' },
                  { action_type: 'b', value: '4' },
                ],
              }),
            ],
          },
        }),
      );
      const [row] = result.result.structured.rows;
      expect(row.metrics.some_future_ratio).toBeUndefined();
      expect(row.rates.some_future_ratio).toEqual({ a: 3, b: 4 });
    });

    it('reads one campaign with no ad account configured at all', async () => {
      let path;
      const result = await callTool(
        server,
        'get_insights',
        // A distinct id: an entity-edge URL carries no account, so an id used
        // in an earlier test would be served from the in-isolate cache and this
        // would assert nothing.
        { campaign_ids: ['23999'] },
        authed((url) => {
          path = new URL(url).pathname;
          return { json: { data: [campaignRow()] } };
        }),
      );
      // The account is never used on this path, so demanding one would refuse
      // a request that works.
      expect(result.ok).toBe(true);
      expect(path).toBe('/v26.0/23999/insights');

      const needsAccount = await callTool(server, 'get_insights', { campaign_ids: ['1', '2'] });
      expect(needsAccount.ok).toBe(false);
      expect(needsAccount.error).toContain('No ad account given');
    });

    it('clamps a leap day rather than rolling it into March', async () => {
      const seen = [];
      await callTool(
        server,
        'compare_periods',
        {
          ad_account_id: '8000000003',
          since: '2028-02-01',
          until: '2028-02-29',
          compare_to: 'previous_year',
        },
        authed((url) => {
          seen.push(JSON.parse(query(url).get('time_range')));
          return { json: { data: [] } };
        }),
      );
      // 2027 has no 29th; rolling would have ended this window on 1 March.
      expect(seen[1]).toEqual({ since: '2027-02-01', until: '2027-02-28' });
    });

    it('does not report an empty page as complete when Meta says there is more', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '8000000004' },
        authed({
          json: {
            data: [],
            paging: { cursors: { after: 'MORE' }, next: 'https://graph.facebook.com/next' },
          },
        }),
      );
      expect(result.result.structured.truncated).toBe(true);
      expect(result.result.structured.nextCursor).toBe('MORE');
    });

    it('prints a valueless purchase as zero revenue, not as missing data', async () => {
      const result = await callTool(
        server,
        'get_insights',
        { ad_account_id: '8000000005' },
        authed({
          json: {
            data: [
              campaignRow({
                actions: [{ action_type: 'omni_purchase', value: '37' }],
                action_values: [{ action_type: 'omni_purchase', value: '0' }],
              }),
            ],
          },
        }),
      );
      expect(result.result.text).toContain('37 purchases worth CAD 0.00');
      expect(result.result.text).not.toContain('worth n/a');
    });

    it("prices a foreign campaign's budgets in that campaign's own currency", async () => {
      const asked = [];
      const result = await callTool(
        server,
        'list_entities',
        { ad_account_id: '8000000006', level: 'adset', campaign_id: '23851' },
        authed((url) => {
          const { pathname } = new URL(url);
          asked.push(pathname);
          if (pathname === '/v26.0/act_9999999999') return { json: { currency: 'JPY' } };
          if (pathname === '/v26.0/act_8000000006') return { json: { currency: 'USD' } };
          return {
            json: {
              // The campaign edge reached a campaign in another account.
              data: [
                { id: '1', name: 'Tokyo set', account_id: '9999999999', daily_budget: '5000' },
              ],
            },
          };
        }),
      );
      // ¥5,000/day, not USD 50.00/day.
      expect(result.result.structured.entities[0].dailyBudget).toBe(5000);
      expect(result.result.text).toContain('JPY 5,000.00/day');
      expect(result.result.text).toContain('not the act_8000000006 this call resolved');
      expect(asked).not.toContain('/v26.0/act_8000000006');
    });
  });
});
