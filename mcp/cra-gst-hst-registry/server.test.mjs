import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const ENTRY = {
  text: `<form><input type="hidden" name="struts.token.name" value="token" />
    <input type="hidden" name="token" value="TOKEN123" /></form>`,
  headers: { 'set-cookie': 'TS010a5239=sessionvalue; path=/; secure' },
};

/** The result screen (B-BN-REG-02) carrying one verdict sentence. */
const resultPage = (sentence) => ({
  text: `<main>
    <div class="row"><div class="col-md-2"><strong>Result</strong></div>
    <div class="col-md-10">
      ${sentence}
    </div></div>
    <dl id="wb-dtmd"><dd property="identifier">B-BN-REG-02</dd></dl>
  </main>`,
});

/** The input screen (B-BN-REG-01) re-rendered with per-field validation messages. */
const errorPage = (...messages) => ({
  text: `<main><section class="alert alert-danger"><h2>Please correct the errors</h2></section>
    ${messages
      .map((m) => `<span class="strong error label label-danger label-error">${m}</span>`)
      .join('')}
    <dl id="wb-dtmd"><dd property="identifier">B-BN-REG-01</dd></dl></main>`,
});

/**
 * The live shape: a GET mints the token, the POST 302s, and the verdict is only
 * on the followed GET. `seen` records the requests so the redirect handling and
 * cookie propagation can be asserted rather than assumed.
 */
const registryResponder = (final, seen = []) => {
  let gets = 0;
  return (url, init) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      cookie: new Headers(init?.headers ?? {}).get('cookie'),
      body: init?.body,
    });
    if (init?.method === 'POST') {
      return {
        status: 302,
        headers: {
          location:
            'https://www.businessregistration-inscriptionentreprise.gc.ca/ebci/brom/registry/pub/reg_02_Ld.action',
          'set-cookie': 'Apache=affinity; path=/',
        },
      };
    }
    gets += 1;
    return gets === 1 ? ENTRY : final;
  };
};

/** Verbatim captures of live CRA screens — see `fixtures/`. */
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const LIVE = {
  registered: fixture('result-registered.html'),
  unconfirmed: fixture('result-unconfirmed.html'),
  notOnDate: fixture('result-not-registered-on-date.html'),
  badNumber: fixture('input-invalid-business-number.html'),
  invalidSubmission: fixture('invalid-form-submission.html'),
};

const ok = (result) => {
  expect(result.ok).toBe(true);
  return result.result;
};

const ARGS = {
  businessNumber: '830951471',
  businessName: 'WARLINE PAINTING LTD.',
  transactionDate: '2026-07-01',
};

describe('cra-gst-hst-registry MCP server', () => {
  it('exposes exactly one tool', () => {
    expect(server.tools.map((t) => t.name)).toEqual(['confirm_gst_hst_number']);
  });

  it('confirms a registered number and reports the CRA sentence verbatim', async () => {
    const seen = [];
    const result = ok(
      await callTool(
        server,
        'confirm_gst_hst_number',
        ARGS,
        registryResponder(resultPage('GST/HST number registered on this transaction date.'), seen),
      ),
    );
    const structured = result.structured;
    expect(structured.verdict).toBe('registered');
    expect(structured.registered).toBe(true);
    expect(structured.businessNumber).toBe('830951471');
    expect(structured.craMessage).toBe('GST/HST number registered on this transaction date.');

    // Two requests before the redirect: the token GET, then the submit POST.
    expect(seen[0].method).toBe('GET');
    expect(seen[1].method).toBe('POST');
    expect(seen[1].body).toContain('token=TOKEN123');
    expect(seen[1].body).toContain('businessNumber=830951471');
    expect(seen[1].body).toContain('requestDate=2026-07-01');
    // The verdict only renders on the followed GET, and only if the session cookie rides along.
    expect(seen[2].url).toContain('reg_02_Ld.action');
    expect(seen[2].cookie).toContain('TS010a5239=sessionvalue');
  });

  // The negative sentence contains the affirmative one as a substring, so a naive
  // `includes('registered on this transaction date')` reports "not registered" as registered.
  it('does not read "was not registered" as registered', async () => {
    const result = ok(
      await callTool(
        server,
        'confirm_gst_hst_number',
        ARGS,
        registryResponder(
          resultPage('GST/HST number was not registered on this transaction date.'),
        ),
      ),
    );
    const structured = result.structured;
    expect(structured.verdict).toBe('notRegisteredOnDate');
    expect(structured.registered).toBe(false);
  });

  // A name mismatch on a live, valid number is answered identically to an unissued
  // number — the CRA will not say which. It must never be reported as unregistered.
  it('reports a name mismatch as unconfirmed, not as unregistered', async () => {
    const result = ok(
      await callTool(
        server,
        'confirm_gst_hst_number',
        { ...ARGS, businessName: 'Warline Painting' },
        registryResponder(resultPage('Insufficient information entered.')),
      ),
    );
    const structured = result.structured;
    expect(structured.verdict).toBe('unconfirmed');
    expect(structured.registered).toBe(false);
    expect(result.text).toContain('NOT CONFIRMED');
    expect(result.text).toContain('NOT proof the number is unregistered');
  });

  it("surfaces the CRA's own validation message for a rejected input", async () => {
    const result = await callTool(
      server,
      'confirm_gst_hst_number',
      { ...ARGS, businessNumber: '123456789' },
      registryResponder(errorPage('GST/HST number is not valid.')),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('GST/HST number is not valid.');
  });

  it('surfaces a future-date rejection', async () => {
    const result = await callTool(
      server,
      'confirm_gst_hst_number',
      { ...ARGS, transactionDate: '2099-01-01' },
      registryResponder(errorPage('Transaction date cannot be a future date.')),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Transaction date cannot be a future date.');
  });

  it('strips an RT program suffix rather than refusing the number', async () => {
    const seen = [];
    ok(
      await callTool(
        server,
        'confirm_gst_hst_number',
        { ...ARGS, businessNumber: '830951471RT0001' },
        registryResponder(resultPage('GST/HST number registered on this transaction date.'), seen),
      ),
    );
    expect(seen[1].body).toContain('businessNumber=830951471');
    expect(seen[1].body).not.toContain('RT0001');
  });

  it('refuses a malformed number before spending a round trip', async () => {
    const result = await callTool(server, 'confirm_gst_hst_number', {
      ...ARGS,
      businessNumber: '12345',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('first 9 digits');
  });

  it('rejects a transaction date that is not yyyy-mm-dd', async () => {
    const result = await callTool(server, 'confirm_gst_hst_number', {
      ...ARGS,
      transactionDate: '01/07/2026',
    });
    expect(result.ok).toBe(false);
  });

  it('maps a 500 on the entry screen to a retryable error', async () => {
    const result = await callTool(server, 'confirm_gst_hst_number', ARGS, {
      status: 500,
      text: 'boom',
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/unavailable/i);
  });

  it('treats an entry screen with no Struts token as retryable', async () => {
    const result = await callTool(server, 'confirm_gst_hst_number', ARGS, {
      text: '<form>no token here</form>',
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatch(/usable session/i);
  });

  it('maps a 500 on the submit itself to a retryable error', async () => {
    const result = await callTool(server, 'confirm_gst_hst_number', ARGS, (_url, init) =>
      init?.method === 'POST' ? { status: 500, text: 'boom' } : ENTRY,
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('500');
  });

  // The verdict lives behind the redirect, so a failure there is not a failure to answer.
  it('maps a failure on the followed redirect to a retryable error', async () => {
    let gets = 0;
    const result = await callTool(server, 'confirm_gst_hst_number', ARGS, (_url, init) => {
      if (init?.method === 'POST') {
        return {
          status: 302,
          headers: {
            location:
              'https://www.businessregistration-inscriptionentreprise.gc.ca/ebci/brom/registry/pub/reg_02_Ld.action',
          },
        };
      }
      gets += 1;
      return gets === 1 ? ENTRY : { status: 503, text: 'down' };
    });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('503');
  });

  it('treats a missing verdict as retryable rather than answering', async () => {
    const result = await callTool(
      server,
      'confirm_gst_hst_number',
      ARGS,
      registryResponder({
        text: '<main><dl id="wb-dtmd"><dd property="identifier">B-BN-REG-02</dd></dl></main>',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no verdict');
  });

  // The five screens below are verbatim captures. The hand-built pages above keep the
  // transport assertions readable; these prove the parsing against the real markup.
  describe('against captured live screens', () => {
    const REDIRECT = {
      status: 302,
      headers: {
        location:
          'https://www.businessregistration-inscriptionentreprise.gc.ca/ebci/brom/registry/pub/reg_02_Ld.action',
      },
    };

    const callLive = (page, arguments_ = ARGS) => {
      let gets = 0;
      return callTool(server, 'confirm_gst_hst_number', arguments_, (_url, init) => {
        if (init?.method === 'POST') return REDIRECT;
        gets += 1;
        return gets === 1 ? ENTRY : { text: page };
      });
    };

    it('reads the registered verdict off the real screen', async () => {
      const result = ok(await callLive(LIVE.registered));
      expect(result.structured.verdict).toBe('registered');
      expect(result.structured.craMessage).toBe(
        'GST/HST number registered on this transaction date.',
      );
    });

    it('reads the not-registered-on-date verdict off the real screen', async () => {
      const result = ok(await callLive(LIVE.notOnDate));
      expect(result.structured.verdict).toBe('notRegisteredOnDate');
      expect(result.structured.registered).toBe(false);
    });

    it('reads the unconfirmed verdict off the real screen', async () => {
      const result = ok(await callLive(LIVE.unconfirmed));
      expect(result.structured.verdict).toBe('unconfirmed');
      expect(result.text).toContain('NOT CONFIRMED');
    });

    it("surfaces the real screen's validation message", async () => {
      const result = await callLive(LIVE.badNumber);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('GST/HST number is not valid.');
    });

    // Dropping the session cookie produces this bilingual page — no Screen ID, no
    // verdict, no field errors. It must be retryable, never parsed as an answer.
    it('treats the Invalid Form Submission page as retryable, not as a verdict', async () => {
      const result = await callLive(LIVE.invalidSubmission);
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/did not return a result/i);
    });

    // The verdict is only meaningful for the number that was asked about.
    it('refuses a result screen that answers about a different number', async () => {
      const result = await callLive(LIVE.registered, { ...ARGS, businessNumber: '000000000' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('830951471');
      expect(result.retryable).toBe(true);
    });
  });
});
