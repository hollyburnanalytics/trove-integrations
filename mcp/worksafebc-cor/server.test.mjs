import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

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

    it('rejects a name below the site minimum without a round trip', async () => {
      const result = await callTool(server, 'search_employers', { name: 'abc' });
      expect(result.ok).toBe(false);
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

    // Expiry is the point of the lookup: a lapsed certificate must not read as current.
    it('flags an expired certificate', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '758078' }, () =>
          detailsPage('OLD CO LTD', '', [{ ...CERTS[0], expiry: '2019/04/29' }]),
        ),
      );
      expect(result.structured.certificates[0].expired).toBe(true);
      expect(result.text).toContain('EXPIRED');
    });

    // Two certificates on one employer: units must not migrate to the wrong one.
    it('attributes classification units to the certificate they sit under', async () => {
      const result = ok(
        await callTool(server, 'get_employer_certificates', { employerId: '758078' }, () =>
          detailsPage('TWO CERT CO', '', [
            {
              partner: 'BCCSA',
              type: 'OHS',
              number: 'A1',
              expiry: '2099/01/01',
              units: [{ code: '721028', description: 'Construction' }],
            },
            {
              partner: 'BCMSA',
              type: 'RTW',
              number: 'B2',
              expiry: '2099/02/02',
              units: [
                { code: '753004', description: 'Municipal' },
                { code: '753011', description: 'Utilities' },
              ],
            },
          ]),
        ),
      );
      const [first, second] = result.structured.certificates;
      expect(first.classificationUnits.map((u) => u.code)).toEqual(['721028']);
      expect(second.corType).toBe('Return to Work');
      expect(second.classificationUnits.map((u) => u.code)).toEqual(['753004', '753011']);
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
    const PARTNER_GRID = `{"Data":[
      {"EmployerId":256,"AccountNumber":"000000256","LegalName":"CITY OF COURTENAY","CORTypeCode":"OHS","CertificateNumber":"0000002560820240917HL","ExpiryDate":"2099/07/11","CUCode":"753004"},
      {"EmployerId":405,"AccountNumber":"000000405","LegalName":"CITY OF BURNABY","CORTypeCode":"OHS","CertificateNumber":"0000004050820250108HL","ExpiryDate":"2019/11/03","CUCode":"753004 753011"}
    ],"Total":76}`;

    it('returns certificates inline and flags the expired one', async () => {
      const seen = [];
      const result = ok(
        await callTool(
          server,
          'list_certified_employers',
          { certifyingPartnerId: '000810731', pageSize: 2 },
          gridResponder(PARTNER_GRID, seen),
        ),
      );
      expect(result.structured.total).toBe(76);
      const [first, second] = result.structured.employers;
      expect(first.expiryDate).toBe('2099-07-11');
      expect(first.expired).toBe(false);
      expect(second.expired).toBe(true);
      expect(second.classificationUnits).toEqual(['753004', '753011']);
      expect(result.text).toContain('EXPIRED');
      expect(result.text).toContain('74 more not shown');

      // This grid's antiforgery pair comes from `/`, not the employer-search page —
      // a token minted on the other page is rejected with a 302 by the live app.
      expect(seen[0].url).toBe('https://corcp.online.worksafebc.com/');
      expect(seen[1].body).toContain('certifyingPartnerEmployerId=000810731');
    });

    it('reports an unknown partner id as an empty list, not a crash', async () => {
      const result = ok(
        await callTool(
          server,
          'list_certified_employers',
          { certifyingPartnerId: '000000000' },
          gridResponder('{"Data":[],"Total":0}'),
        ),
      );
      expect(result.structured.count).toBe(0);
      expect(result.text).toMatch(/list_certifying_partners/);
    });
  });
});
