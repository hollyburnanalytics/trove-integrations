import { defineMcpServer, type ToolContext, ToolError, tool, z } from '@ontrove/mcp';

/**
 * CRA GST/HST Registry — a hosted MCP server over the Canada Revenue Agency's
 * public GST/HST Registry, the service that lets a registrant confirm a
 * supplier's GST/HST account number before claiming an input tax credit on the
 * tax that supplier charged.
 *
 * One tool, because the CRA offers one operation: `confirm_gst_hst_number`
 * takes the number, the business name and the transaction date, and answers for
 * that date. It is **not** a directory — there is no name search, no lookup by
 * number alone, and the CRA never discloses who a number belongs to. That
 * asymmetry is the whole design constraint here (see `classifyResult`).
 *
 * Transport notes (probed live). The app is Struts, form-only, with no API and
 * no CAPTCHA. Two requests per call:
 *  1. `GET  /ebci/brom/registry/pub/reg_01_Ld.action`   — mints a single-use
 *     Struts token (`struts.token.name` + `token`) and the session cookie.
 *  2. `POST /ebci/brom/registry/pub/reg_01_Sbmt.action` — 302s to
 *     `reg_02_Ld.action`, where the answer is rendered (Post-Redirect-Get).
 * The redirect is followed by hand carrying the session cookie, because `fetch`
 * does not persist a `Set-Cookie` across a redirect. That cookie is not optional:
 * dropping it was tested, and the followed GET then serves a bilingual
 * "Invalid Form Submission — for your protection, the form submission was
 * ignored" page with no Screen ID and no result. The Struts token is likewise
 * single-use — replaying one redirects to `srvmsgNvldTkn.jsp` — so every call
 * mints its own.
 *
 * Terms of use: the CRA asks that the registry be used only to validate a
 * business's GST/HST number, and prohibits commercial reproduction of results;
 * it states it "is not intended to be a search engine". This server matches
 * that shape deliberately — one number per call, nothing stored, no bulk tool.
 */

const BASE_URL = 'https://www.businessregistration-inscriptionentreprise.gc.ca';
const ENTRY_URL = `${BASE_URL}/ebci/brom/registry/pub/reg_01_Ld.action`;
const SUBMIT_URL = `${BASE_URL}/ebci/brom/registry/pub/reg_01_Sbmt.action`;
/** The CRA's own landing page for the service — the citable URL for a result. */
const PUBLIC_URL =
  'https://www.canada.ca/en/revenue-agency/services/e-services/digital-services-businesses/confirming-a-gst-hst-account-number.html';

const HTML_HEADERS: Record<string, string> = { accept: 'text/html' };

const TOKEN_RE = /name="token"\s+value="([^"]*)"/;
/** `<strong>Result</strong>` … the next value cell holds the CRA's verdict. */
const RESULT_RE =
  /<strong>Result\s*<\/strong>[\s\S]{0,200}?<div class="col-md-10">([\s\S]*?)<\/div>/;
/** The result screen echoes the submitted number back above the verdict. */
const ECHOED_NUMBER_RE =
  /<strong>GST\/HST number\s*<\/strong>[\s\S]{0,200}?<div class="col-md-10">([\s\S]*?)<\/div>/;
/** A per-field validation message on the input screen. */
const FIELD_ERROR_RE = /<span class="strong error[^"]*">([\s\S]*?)<\/span>/g;
/** Screen ID: `B-BN-REG-02` is the result screen, `B-BN-REG-01` the input form. */
const SCREEN_RE = /property="identifier">([^<]*)</;

/** The four outcomes the registry can report. */
type Verdict = 'registered' | 'notRegisteredOnDate' | 'unconfirmed';

/** Strip tags/entities from an HTML fragment down to one line of text. */
function plainText(html: string): string {
  return html
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Map the CRA's result sentence onto a verdict.
 *
 * The order matters: "was **not** registered on this transaction date" contains
 * the affirmative sentence as a substring, so the negative is tested first.
 *
 * `unconfirmed` is the load-bearing case. When the name does not match CRA
 * records the registry answers "Insufficient information entered" — the *same*
 * answer it gives for a number that was never issued, because the CRA will not
 * reveal whose number it is. Reporting that as "not registered" would be a
 * confidently wrong answer about a live registrant, so it is named as
 * unconfirmed, with the remedy attached.
 *
 * What the name match actually tolerates was measured against one live number
 * rather than assumed, because the guidance to callers depends on it. Accepted:
 * lower case (`warline painting ltd.`), a missing final period (`… LTD`), and
 * collapsed/padded whitespace. Rejected: any *incomplete* name
 * (`WARLINE PAINTING`, `Warline`), a spelled-out synonym for the suffix
 * (`… LIMITED` for `… LTD.`), an extra token (`… LTD. INC`), and a typo
 * (`Pointing`). So it normalizes case, spacing and trailing punctuation, but
 * needs the whole registered name — which is why the advice is "get the exact
 * legal name", not "match the CRA's capitalization".
 */
function classifyResult(sentence: string): Verdict {
  const text = sentence.toLowerCase();
  if (text.includes('not registered')) return 'notRegisteredOnDate';
  if (text.includes('registered on this transaction date')) return 'registered';
  return 'unconfirmed';
}

const VERDICT_SUMMARY: Record<Verdict, string> = {
  registered: 'Registered for GST/HST on the transaction date.',
  notRegisteredOnDate:
    'The number exists but was NOT registered for GST/HST on that transaction date.',
  unconfirmed:
    'NOT CONFIRMED. The CRA could not match this number, name and date together — and it does ' +
    'not say which of the three is wrong, because it never discloses whose number it is. The ' +
    'usual cause is an incomplete business name: case, spacing and a missing final period are ' +
    'all tolerated, but the whole registered name is required, so "Acme Paving" fails where ' +
    '"Acme Paving Ltd." succeeds, and "Limited" does not stand in for "Ltd.". Retry with the ' +
    'exact legal name (orgbook-bc has it for BC companies). This is NOT proof the number is ' +
    'unregistered.',
};

/** Merge `name=value` pairs from a Cookie header with Set-Cookie values (new wins). */
function mergeCookies(cookieHeader: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  const add = (pair: string) => {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  };
  for (const pair of cookieHeader.split('; ')) add(pair);
  for (const setCookie of setCookies) add(setCookie.split(';')[0] ?? '');
  return [...jar]
    .filter(([name]) => name !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** GET the entry screen for its single-use Struts token and session cookie. */
async function getSession(ctx: ToolContext): Promise<{ token: string; cookie: string }> {
  const res = await ctx.fetch(ENTRY_URL, { headers: { ...HTML_HEADERS } });
  if (!res.ok) {
    throw new ToolError('The CRA GST/HST Registry is temporarily unavailable.', {
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const html = await res.text();
  const token = TOKEN_RE.exec(html)?.[1];
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .filter((pair): pair is string => Boolean(pair))
    .join('; ');
  // Both halves are required — the submit is answered with "Invalid Form Submission"
  // if the cookie is missing, and with the invalid-token screen if the token is.
  if (!token || cookie === '') {
    throw new ToolError('The CRA GST/HST Registry did not return a usable session.', {
      retryable: true,
    });
  }
  return { token, cookie };
}

/** Follow the submit redirect to the result screen, carrying the session cookie. */
async function readResultPage(post: Response, cookie: string, ctx: ToolContext): Promise<string> {
  if (post.status >= 300 && post.status < 400) {
    const merged = mergeCookies(cookie, post.headers.getSetCookie?.() ?? []);
    const location = new URL(post.headers.get('location') ?? '/', BASE_URL).toString();
    const res = await ctx.fetch(location, {
      headers: { ...HTML_HEADERS, ...(merged === '' ? {} : { cookie: merged }) },
    });
    if (!res.ok) {
      throw new ToolError(`The CRA GST/HST Registry returned HTTP ${res.status}.`, {
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return res.text();
  }
  if (!post.ok) {
    throw new ToolError(`The CRA GST/HST Registry returned HTTP ${post.status}.`, {
      retryable: post.status >= 500 || post.status === 429,
    });
  }
  return post.text();
}

/** Nine digits — the BN portion of a GST/HST number, without the `RT0001` suffix. */
const BUSINESS_NUMBER_RE = /^\d{9}$/;

export default defineMcpServer({
  egress: ['www.businessregistration-inscriptionentreprise.gc.ca'],
  tools: [
    tool({
      name: 'confirm_gst_hst_number',
      title: 'CRA: Confirm a GST/HST account number',
      description:
        "Confirm one supplier's GST/HST account number against the CRA's public GST/HST " +
        'Registry, for a given transaction date — the check that supports an input tax credit ' +
        'claim on the GST/HST that supplier charged. Needs all three of: the first 9 digits of ' +
        'the GST/HST number, the business name as CRA records it, and the transaction date ' +
        '(not in the future). Returns registered / not registered on that date / not confirmed. ' +
        'This is a verification, NOT a search: there is no lookup by name, no lookup by number ' +
        'alone, and the CRA never discloses whose number it is — so a name that does not match ' +
        'its records comes back "not confirmed", which is not the same as unregistered. Pair it ' +
        "with orgbook-bc to get a BC company's exact legal name and business number first.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        businessNumber: z
          .string()
          .min(1)
          .describe(
            'The first 9 digits of the GST/HST number, e.g. "830951471". Drop the "RT0001" ' +
              'program suffix and any spaces.',
          ),
        businessName: z
          .string()
          .min(1)
          .max(175)
          .describe(
            'The business name as CRA records it. Case, extra spacing and a missing final ' +
              'period are tolerated, but the name must be COMPLETE: "Acme Paving Ltd." ' +
              'matches where "Acme Paving" does not, and "Limited" will not stand in for ' +
              '"Ltd.".',
          ),
        transactionDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd.')
          .describe('Transaction/invoice date, yyyy-mm-dd. Cannot be in the future.'),
      }),
      output: z.object({
        verdict: z.enum(['registered', 'notRegisteredOnDate', 'unconfirmed']),
        registered: z.boolean(),
        businessNumber: z.string(),
        businessName: z.string(),
        transactionDate: z.string(),
        craMessage: z.string(),
        url: z.string(),
      }),
      async handler(args, ctx) {
        const businessNumber = args.businessNumber.replaceAll(/[\s-]/g, '').toUpperCase();
        // The CRA wants the 9-digit BN; an "RT0001" suffix is a common paste and is dropped
        // rather than refused, but anything else is named before a round trip is spent on it.
        const digits = businessNumber.replace(/R[TCPM]\d{4}$/, '');
        if (!BUSINESS_NUMBER_RE.test(digits)) {
          throw new ToolError(
            `"${args.businessNumber}" is not a GST/HST number. Enter the first 9 digits, ` +
              'e.g. "830951471" from "830951471RT0001".',
            { retryable: false },
          );
        }
        ctx.log('confirm_gst_hst_number', {
          businessNumber: digits,
          transactionDate: args.transactionDate,
        });

        const { token, cookie } = await getSession(ctx);
        const post = await ctx.fetch(SUBMIT_URL, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            ...HTML_HEADERS,
            'content-type': 'application/x-www-form-urlencoded',
            cookie,
          },
          body: new URLSearchParams({
            'struts.token.name': 'token',
            token,
            businessNumber: digits,
            businessName: args.businessName.trim(),
            requestDate: args.transactionDate,
            'reg.label.submit': 'Search',
          }).toString(),
        });
        const html = await readResultPage(post, cookie, ctx);

        // The registry re-renders the input screen (B-BN-REG-01) with per-field messages when
        // it rejects an input outright — a bad check digit, a future date. Those are the
        // caller's to fix, and the CRA's own wording is the most useful thing to hand back.
        const screen = SCREEN_RE.exec(html)?.[1]?.trim();
        if (screen !== 'B-BN-REG-02') {
          const errors = [...html.matchAll(FIELD_ERROR_RE)]
            .map((match) => plainText(match[1] ?? ''))
            .filter((message) => message !== '');
          throw new ToolError(
            errors.length > 0
              ? `The CRA rejected the request: ${errors.join(' ')}`
              : 'The CRA GST/HST Registry did not return a result; try again.',
            { retryable: errors.length === 0 },
          );
        }

        // The result screen echoes the three inputs back above the verdict. They are
        // compared against what was sent: the verdict is only meaningful for the question
        // that was asked, and a session mix-up would otherwise be reported as an answer.
        const echoed = plainText(ECHOED_NUMBER_RE.exec(html)?.[1] ?? '');
        if (echoed !== '' && echoed !== digits) {
          throw new ToolError(`The CRA answered for GST/HST ${echoed}, not ${digits}; try again.`, {
            retryable: true,
          });
        }

        const sentence = plainText(RESULT_RE.exec(html)?.[1] ?? '');
        if (sentence === '') {
          throw new ToolError('The CRA GST/HST Registry returned no verdict; try again.', {
            retryable: true,
          });
        }
        const verdict = classifyResult(sentence);
        const structured = {
          verdict,
          registered: verdict === 'registered',
          businessNumber: digits,
          businessName: args.businessName.trim(),
          transactionDate: args.transactionDate,
          craMessage: sentence,
          url: PUBLIC_URL,
        };
        return {
          text:
            `GST/HST ${digits} — "${structured.businessName}" on ${args.transactionDate}\n` +
            `  ${VERDICT_SUMMARY[verdict]}\n` +
            `  CRA: ${sentence}`,
          structured,
        };
      },
    }),
  ],
});
