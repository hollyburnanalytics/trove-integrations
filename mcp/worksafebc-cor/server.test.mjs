import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** Verbatim captures of live responses — see `fixtures/`. */
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const FIXTURE_TWO_CERTIFICATES = fixture('employer-details-two-certificates.html');
const FIXTURE_PARTNER_EMPLOYERS = fixture('certifying-partner-employers.json');
const FIXTURE_PARTNER_MULTI_CU = fixture('certifying-partner-multi-cu.json');

/** A landing page carrying the antiforgery hidden field, paired with its cookie. */
const landing = (token, extra = '') => ({
  text: `<form><input name="__RequestVerificationToken" type="hidden" value="${token}" />${extra}</form>`,
  headers: { 'set-cookie': `__RequestVerificationToken=cookie-${token}; path=/; httponly` },
});

const PARTNER_OPTIONS = `<select id="SelectedCertifyingPartner">
  <option value="">-- Select --</option>
  <option value="000850381">B.C. CONSTRUCTION SAFETY ALLIANCE</option>
  <option value="000810731">BC MUNICIPAL SAFETY ASSOCIATION</option>
  <option value="000672839">B.C. ROAD CONSTRUCTION &amp; MAINTENANCE SAFETY NETWORK(HISTORICAL)</option>
</select>`;

/** A GET → landing, POST → grid-JSON responder (`grid` is raw JSON text), recording every request. */
const gridResponder = (grid, seen = [], token = 'TOK1', landingExtra = '') => {
  return (url, init) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      cookie: new Headers(init?.headers ?? {}).get('cookie'),
      body: init?.body,
    });
    return init?.method === 'POST' ? { text: grid } : landing(token, landingExtra);
  };
};

/**
 * An employer-details page. Certificate rows open with four plain cells; each
 * nests a classification-unit grid whose rows have exactly two cells — the same
 * shape the live app renders, which is what the parser tells apart.
 */
const detailsPage = (legalName, tradeName, certificates) => ({
  text: `<div>
    <div class="col-12 row">
      <div class="col-3"><label for="EmployerId">Employer ID:</label></div>
      <div class="col-auto"><strong>000758078</strong></div>
    </div>
    <div class="col-12 row">
      <div class="col-3"><label for="LegalName">Employer legal name:</label></div>
      <div class="col-auto"><strong>${legalName}</strong></div>
    </div>
    <div class="col-12 row">
      <div class="col-3"><label for="TradeName">Employer trade name:</label></div>
      <div class="col-auto"><strong>${tradeName}</strong></div>
    </div>
    <table><tbody>
      ${certificates
        .map(
          (c) =>
            `<tr class="k-master-row"><td>${c.partner}</td><td>${c.type}</td><td>${c.number}</td><td>${c.expiry}</td>` +
            `<td><div class="k-widget k-grid"><table><tbody>${c.units
              .map(
                (u) => `<tr class="k-master-row"><td>${u.code}</td><td>${u.description}</td></tr>`,
              )
              .join('')}</tbody></table></div></td></tr>`,
        )
        .join('')}
    </tbody></table>
  </div>`,
});

/**
 * The certifying-partner grid always answers from `/`, whose landing page carries the
 * partner `<select>` the id is validated against. Verbatim captures throughout: this
 * grid packs two values into each of two columns, which a hand-written fixture would
 * not reproduce.
 */
const partnerResponder = (grid, seen = []) => gridResponder(grid, seen, 'TOK1', PARTNER_OPTIONS);

const ok = (result) => {
  expect(result.ok).toBe(true);
  return result.result;
};

describe('worksafebc-cor MCP server', () => {
  it('lists the four tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_employer_certificates',
      'list_certified_employers',
      'list_certifying_partners',
      'search_employers',
    ]);
  });

  describe('search_employers', () => {
    // Verbatim wire bytes, including the JSON nulls and the HTML-escaped ampersand
    // the live endpoint serves — parsed here rather than re-typed as JS literals.
    const SEARCH_GRID = `{"Data":[
      {"EmployerId":758078,"LegalName":"DARWIN CONSTRUCTION (CANADA) LTD","TradeName":null,"Certificates":null},
      {"EmployerId":66381,"LegalName":"TRAYLOR INFRASTRUCTURE CANADA, ULC &amp; AECON CONSTRUCTION GROUP","TradeName":"O&#39;BRIEN &#x26; SONS","Certificates":null}
    ],"Total":214}`;

    it('returns hits with zero-padded account numbers and a details URL', async () => {
      const seen = [];
      const result = ok(
        await callTool(
          server,
          'search_employers',
          { name: 'construction' },
          gridResponder(SEARCH_GRID, seen),
        ),
      );
      expect(result.structured.total).toBe(214);
      expect(result.structured.count).toBe(2);
      const [first, second] = result.structured.employers;
      expect(first.accountNumber).toBe('000758078');
      expect(first.url).toBe(
        'https://corcp.online.worksafebc.com/Home/EmployerDetails?employerId=758078',
      );
      // Kendo serves HTML-escaped names in JSON: named, decimal and hex entities all appear.
      expect(second.legalName).toBe(
        'TRAYLOR INFRASTRUCTURE CANADA, ULC & AECON CONSTRUCTION GROUP',
      );
      expect(second.tradeName).toBe("O'BRIEN & SONS");

      // The antiforgery field and the cookie minted with it must both ride on the POST.
      expect(seen[0].url).toBe('https://corcp.online.worksafebc.com/Home/EmployerSearch');
      expect(seen[1].method).toBe('POST');
      expect(seen[1].body).toContain('__RequestVerificationToken=TOK1');
      expect(seen[1].cookie).toContain('__RequestVerificationToken=cookie-TOK1');
      expect(seen[1].body).toContain('employerNameType=LN');
    });

    it('maps nameType "trade" to the site\'s TN code', async () => {
      const seen = [];
      ok(
        await callTool(
          server,
          'search_employers',
          { name: 'traylor', nameType: 'trade' },
          gridResponder(SEARCH_GRID, seen),
        ),
      );
      expect(seen[1].body).toContain('employerNameType=TN');
    });

    // A page is not the answer: 25 of 214 must say so, or a caller reads the page as the total.
    it('says how many matches were not shown', async () => {
      const result = ok(
        await callTool(
          server,
          'search_employers',
          { name: 'construction', pageSize: 2 },
          gridResponder(SEARCH_GRID),
        ),
      );
      expect(result.text).toContain('2 of 214');
      expect(result.text).toContain('212 more not shown');
      expect(result.text).toContain('page 2');
    });

    it('pages with skip/take derived from page and pageSize', async () => {
      const seen = [];
      ok(
        await callTool(
          server,
          'search_employers',
          { name: 'construction', page: 3, pageSize: 25 },
          gridResponder(SEARCH_GRID, seen),
        ),
      );
      expect(seen[1].body).toContain('skip=50');
      expect(seen[1].body).toContain('take=25');
    });

    // Only COR holders are in this registry; an empty result is not evidence a firm
    // is unregistered with WorkSafeBC, and the tool must not let that be inferred.
    it('says an empty result does not mean unregistered', async () => {
      const result = ok(
        await callTool(
          server,
          'search_employers',
          { name: 'nobody at all' },
          gridResponder('{"Data":[],"Total":0}'),
        ),
      );
      expect(result.structured.count).toBe(0);
      expect(result.text).toMatch(/hold no Certificate of Recognition/i);
    });

    // Measured live: a search matching exactly ONE employer does not return a one-row
    // grid — it 302s to that employer's details page. Failing that redirect broke the
    // single most likely query this tool gets ("is *this* firm certified?").
    it('resolves a single-match redirect into a one-row result', async () => {
      const seen = [];
      const result = ok(
        await callTool(server, 'search_employers', { name: 'al stober' }, (url, init) => {
          seen.push(url);
          if (init?.method === 'POST') {
            return {
              status: 302,
              headers: { location: '/Home/EmployerDetails?employerId=1214' },
            };
          }
          return url.includes('EmployerDetails')
            ? { text: FIXTURE_TWO_CERTIFICATES }
            : landing('TOK1');
        }),
      );
      expect(result.structured.total).toBe(1);
      expect(result.structured.count).toBe(1);
      const [only] = result.structured.employers;
      expect(only.employerId).toBe(1214);
      expect(only.accountNumber).toBe('000001214');
      expect(only.legalName).toBe('CITY OF MISSION');
      expect(seen.some((u) => u.includes('EmployerDetails?employerId=1214'))).toBe(true);
    });

    // WorkSafeBC's form declares a 5-character minimum; the endpoint behind it serves 4.
    it('accepts a four-character name, which the site form would refuse', async () => {
      const result = ok(
        await callTool(
          server,
          'search_employers',
          { name: 'wood' },
          gridResponder('{"Data":[],"Total":0,"Errors":null}'),
        ),
      );
      expect(result.structured.count).toBe(0);
    });

    it('still refuses three characters, which the endpoint rejects', async () => {
      const result = await callTool(server, 'search_employers', { name: 'abc' });
      expect(result.ok).toBe(false);
    });

    // Errors has been null on every observed success; if it ever arrives populated
    // alongside an empty Data, that must not be reported as "no matches".
    it('raises when the payload carries an Errors value', async () => {
      const result = await callTool(
        server,
        'search_employers',
        { name: 'construction' },
        gridResponder('{"Data":null,"Total":0,"Errors":"search failed"}'),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('search failed');
    });

    // A stale antiforgery pair 302s to /Error/Index instead of erroring, so following the
    // redirect would parse an error page as "no matches".
    it('treats the 302 to /Error/Index as retryable, not as zero results', async () => {
      const result = await callTool(
        server,
        'search_employers',
        { name: 'construction' },
        (_url, init) =>
          init?.method === 'POST'
            ? { status: 302, headers: { location: '/Error/Index?ErrorType=GeneralError' } }
            : landing('TOK1'),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });

    it('treats a landing page with no antiforgery token as retryable', async () => {
      const result = await callTool(
        server,
        'search_employers',
        { name: 'construction' },
        {
          text: '<form>no token</form>',
        },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/usable session/i);
    });

    it('maps a 503 on the grid endpoint to a retryable error', async () => {
      const result = await callTool(
        server,
        'search_employers',
        { name: 'construction' },
        (_url, init) => (init?.method === 'POST' ? { status: 503, text: 'down' } : landing('TOK1')),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('503');
    });

    it('maps a 500 on the landing page to a retryable error', async () => {
      const result = await callTool(
        server,
        'search_employers',
        { name: 'construction' },
        { status: 500, text: 'boom' },
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/unavailable/i);
    });

    it('raises a retryable error when the grid body is not JSON', async () => {
      const result = await callTool(
        server,
        'search_employers',
        { name: 'construction' },
        (_url, init) =>
          init?.method === 'POST' ? { text: '<html>not json</html>' } : landing('TOK1'),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });

  describe('get_employer_certificates', () => {
    const CERTS = [
      {
        partner: 'BCCSA',
        type: 'OHS',
        number: '0007580781120250617HL',
        expiry: '2099/04/29',
        units: [
          { code: '721028', description: 'Industrial, Commercial, Institutional Construction' },
          { code: '721034', description: 'Roadbuilding' },
        ],
      },
    ];

    it('parses the certificate and its nested classification units', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '758078' }, () =>
          detailsPage('DARWIN CONSTRUCTION (CANADA) LTD', '', CERTS),
        ),
      );
      const structured = result.structured;
      expect(structured.accountNumber).toBe('000758078');
      expect(structured.legalName).toBe('DARWIN CONSTRUCTION (CANADA) LTD');
      expect(structured.count).toBe(1);
      const [certificate] = structured.certificates;
      expect(certificate.certifyingPartner).toBe('BCCSA');
      expect(certificate.corType).toBe('Occupational Health & Safety');
      expect(certificate.expiryDate).toBe('2099-04-29');
      expect(certificate.expired).toBe(false);
      expect(certificate.classificationUnits.map((u) => u.code)).toEqual(['721028', '721034']);
    });

    // Both names live in a `<strong>` inside the cell after their `<label for>`;
    // anchoring on the label text and taking the next `<div>` yields whitespace.
    it('reads the legal and trade names out of their labelled cells', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '758078' }, () =>
          detailsPage('TRAYLOR INFRASTRUCTURE CANADA, ULC', 'TRAYLOR - AECON GP', CERTS),
        ),
      );
      expect(result.structured.legalName).toBe('TRAYLOR INFRASTRUCTURE CANADA, ULC');
      expect(result.structured.tradeName).toBe('TRAYLOR - AECON GP');
      expect(result.text).toContain('trading as TRAYLOR - AECON GP');
    });

    // Synthetic date: no expired certificate was found in 739 sampled live rows, so this
    // exercises the guard rather than a case the registry is known to serve.
    it('flags an expired certificate', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '758078' }, () =>
          detailsPage('OLD CO LTD', '', [{ ...CERTS[0], expiry: '2019/04/29' }]),
        ),
      );
      expect(result.structured.certificates[0].expired).toBe(true);
      expect(result.text).toContain('EXPIRED');
    });

    // A real two-certificate employer: City of Mission holds one COR from BCFSC and one
    // from BCMSA, each covering a different classification unit. Verbatim capture, so the
    // nesting the parser has to survive is the app's, not one invented to suit it.
    it('attributes classification units to the certificate they sit under', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '1214' }, () => ({
          text: FIXTURE_TWO_CERTIFICATES,
        })),
      );
      expect(result.structured.legalName).toBe('CITY OF MISSION');
      const [first, second] = result.structured.certificates;
      expect(result.structured.count).toBe(2);
      expect(first.certifyingPartner).toBe('BCFSC');
      expect(first.certificateNumber).toBe('0000012140420250204HS');
      expect(first.classificationUnits).toEqual([
        { code: '703008', description: 'Integrated Forest Management' },
      ]);
      expect(second.certifyingPartner).toBe('BCMSA');
      expect(second.classificationUnits).toEqual([
        { code: '753004', description: 'Local Government and Related Operations' },
      ]);
    });

    it('accepts a zero-padded account number', async () => {
      const seen = [];
      ok(
        await callTool(server, 'get_employer_certificates', { employerId: '000758078' }, (url) => {
          seen.push(url);
          return detailsPage('DARWIN CONSTRUCTION (CANADA) LTD', '', CERTS);
        }),
      );
      expect(seen[0]).toContain('employerId=758078');
    });

    // An unknown employer number 302s to /Error/Index; following it would render a page
    // with no certificate rows, i.e. "this employer holds no COR" — a wrong answer.
    it('does not report an unknown employer as holding no certificate', async () => {
      const result = await callTool(
        server,
        'get_employer_certificates',
        { employerId: '1' },
        () => ({
          status: 302,
          headers: { location: '/Error/Index?ErrorType=GeneralError' },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no COR record/i);
    });

    // The app sometimes serves the error page with a 200 rather than a redirect; it has no
    // certificate rows, so it must not be read as "this employer holds no COR".
    it('does not read a 200 error page as an employer with no certificate', async () => {
      const result = await callTool(
        server,
        'get_employer_certificates',
        { employerId: '1' },
        () => ({
          text: '<html><body><a href="/Error/Index?ErrorType=GeneralError">error</a></body></html>',
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no COR record/i);
    });

    it('reports a genuine no-certificate page as such', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '758078' }, () =>
          detailsPage('NO COR LTD', '', []),
        ),
      );
      expect(result.structured.count).toBe(0);
      expect(result.text).toMatch(/No Certificate of Recognition on file/i);
    });

    it('rejects a non-numeric employer number', async () => {
      const result = await callTool(server, 'get_employer_certificates', {
        employerId: 'BC0731611',
      });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/numeric/i);
    });
  });

  describe('list_certifying_partners', () => {
    it('reads the partners off the landing page select', async () => {
      const result = ok(
        await callTool(server, 'list_certifying_partners', {}, () =>
          landing('TOK2', PARTNER_OPTIONS),
        ),
      );
      expect(result.structured.count).toBe(3);
      expect(result.structured.partners[1]).toEqual({
        id: '000810731',
        name: 'BC MUNICIPAL SAFETY ASSOCIATION',
      });
      // The blank "-- Select --" option is not a partner.
      expect(result.structured.partners.some((p) => p.id === '')).toBe(false);
      expect(result.structured.partners[2].name).toContain('&');
    });

    it('raises rather than reporting an empty partner list', async () => {
      const result = await callTool(server, 'list_certifying_partners', {}, () => landing('TOK2'));
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });

  describe('list_certified_employers', () => {
    it('returns certificates inline and splits the packed legal/trade names', async () => {
      const seen = [];
      const result = ok(
        await callTool(
          server,
          'list_certified_employers',
          { certifyingPartnerId: '000810731', pageSize: 3 },
          partnerResponder(FIXTURE_PARTNER_EMPLOYERS, seen),
        ),
      );
      expect(result.structured.total).toBe(76);
      const [first, , third] = result.structured.employers;

      // `LegalName` arrives as `LEGAL</br/><i>TRADE</i>` — stripping the tags without
      // splitting merged both into the legal name and left tradeName null.
      expect(first.legalName).toBe('MAPLE RIDGE SCHOOL DISTRICT #42');
      expect(first.tradeName).toBe('SCHOOL DISTRICT 42');
      expect(first.accountNumber).toBe('000037591');
      // A row with no packed trade name still reports none.
      expect(third.legalName).toBe('CITY OF MISSION');
      expect(third.tradeName).toBeNull();
      expect(result.text).toContain('73 more not shown');

      // This grid's antiforgery pair comes from `/`, not the employer-search page —
      // a token minted on the other page is rejected with a 302 by the live app.
      expect(seen[0].url).toBe('https://corcp.online.worksafebc.com/');
      expect(seen[1].body).toContain('certifyingPartnerEmployerId=000810731');
    });

    // `CUCode` packs multiple units the same way. Left unsplit, a two-unit employer
    // reported one unit whose "code" was the literal string `721028<br/>761033`.
    it('splits a multi-unit CUCode into separate classification units', async () => {
      const result = ok(
        await callTool(
          server,
          'list_certified_employers',
          { certifyingPartnerId: '000850381' },
          partnerResponder(FIXTURE_PARTNER_MULTI_CU),
        ),
      );
      const [first] = result.structured.employers;
      expect(first.classificationUnits.length).toBeGreaterThan(1);
      for (const code of first.classificationUnits) expect(code).toMatch(/^\d+$/);
    });

    // An unknown id and a stale antiforgery token produce the identical 302, so the id is
    // checked against the landing page's own list first — otherwise a permanent caller
    // error is reported as "try again".
    it('names an unknown partner id instead of telling the caller to retry', async () => {
      const result = await callTool(
        server,
        'list_certified_employers',
        { certifyingPartnerId: '000000000' },
        partnerResponder(FIXTURE_PARTNER_EMPLOYERS),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('not a WorkSafeBC certifying partner id');
      expect(result.error).toContain('000810731');
    });

    // The two partners marked (HISTORICAL) are valid ids that list nobody. Since the id
    // is validated first, an empty page means "nothing listed", not "wrong id".
    it('does not blame the id when a valid partner lists no employers', async () => {
      const result = ok(
        await callTool(
          server,
          'list_certified_employers',
          { certifyingPartnerId: '000672839' },
          partnerResponder('{"Data":[],"Total":0,"Errors":null}'),
        ),
      );
      expect(result.structured.count).toBe(0);
      expect(result.text).toContain('valid certifying partner');
      expect(result.text).toContain('HISTORICAL');
    });

    it('accepts a partner id that is on the landing page', async () => {
      const result = ok(
        await callTool(
          server,
          'list_certified_employers',
          { certifyingPartnerId: '000810731' },
          partnerResponder(FIXTURE_PARTNER_EMPLOYERS),
        ),
      );
      expect(result.structured.count).toBe(3);
    });
  });
});
