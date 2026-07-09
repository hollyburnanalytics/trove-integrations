import { describe, expect, it } from 'bun:test';
import { normalizeAccession, xmlBlocks, xmlFlag, xmlNumber, xmlValue } from './client.ts';
import { filingHtmlToText, findInText, pickPrimaryDocument } from './documents.ts';
import { parseOwnershipXml, summarizeOpenMarket } from './ownership.ts';
import { aggregateHoldings, parseCoverPage, parseInfoTable } from './thirteenf.ts';

// --- XML helpers -------------------------------------------------------------

describe('xml helpers', () => {
  const xml =
    '<root><a><value>hello</value><footnoteId id="F1"/></a>' +
    '<n><value>1,234.5</value></n><f>1</f><ns1:tagged>inner</ns1:tagged>' +
    '<bare>plain &amp; simple</bare><empty><footnoteId id="F2"/></empty></root>';

  it('prefers the <value> child and decodes entities', () => {
    expect(xmlValue(xml, 'a')).toBe('hello');
    expect(xmlValue(xml, 'bare')).toBe('plain & simple');
  });

  it('is namespace-prefix agnostic', () => {
    expect(xmlValue(xml, 'tagged')).toBe('inner');
    expect(xmlBlocks(xml, 'tagged')).toHaveLength(1);
  });

  it('parses numbers with thousands separators', () => {
    expect(xmlNumber(xml, 'n')).toBe(1234.5);
  });

  it('treats footnote-only elements as null', () => {
    expect(xmlValue(xml, 'empty')).toBeNull();
    expect(xmlNumber(xml, 'empty')).toBeNull();
  });

  it('reads SEC boolean flags', () => {
    expect(xmlFlag(xml, 'f')).toBe(true);
    expect(xmlFlag(xml, 'missing')).toBe(false);
  });
});

describe('normalizeAccession', () => {
  it('inserts dashes into a bare 18-digit accession', () => {
    expect(normalizeAccession('000032019325000079')).toBe('0000320193-25-000079');
  });

  it('leaves a dashed accession untouched', () => {
    expect(normalizeAccession('0000320193-25-000079')).toBe('0000320193-25-000079');
  });
});

// --- Form 4 ownership ---------------------------------------------------------

const FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <periodOfReport>2026-06-15</periodOfReport>
  <aff10b5One>true</aff10b5One>
  <issuer><issuerCik>320193</issuerCik><issuerName>Apple Inc.</issuerName></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-15</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value><footnoteId id="F1"/></transactionShares>
        <transactionPricePerShare><value>250.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-14</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>200</value></transactionShares>
        <transactionPricePerShare><value>240</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Restricted Stock Unit</value></securityTitle>
      <transactionDate><value>2026-06-15</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>30104</value></transactionShares>
        <transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <underlyingSecurity><underlyingSecurityTitle><value>Common Stock</value></underlyingSecurityTitle></underlyingSecurity>
      <conversionOrExercisePrice><footnoteId id="F1"/></conversionOrExercisePrice>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;

describe('form 4 parsing', () => {
  const filing = parseOwnershipXml(FORM4_XML);

  it('extracts owner identity and role flags', () => {
    expect(filing.owners).toEqual(['Doe Jane']);
    expect(filing.officerTitle).toBe('Chief Financial Officer');
    expect(filing.isOfficer).toBe(true);
    expect(filing.isDirector).toBe(false);
    expect(filing.planned10b5One).toBe(true);
    expect(filing.periodOfReport).toBe('2026-06-15');
  });

  it('decodes transactions with direction from the A/D code', () => {
    const [sale, buy, exercise] = filing.transactions;
    expect(sale.code).toBe('S');
    expect(sale.codeDescription).toBe('Open-market sale');
    expect(sale.acquiredDisposed).toBe('D');
    expect(sale.shares).toBe(1000);
    expect(sale.pricePerShare).toBe(250.5);
    expect(sale.value).toBe(250_500);
    expect(sale.sharesOwnedAfter).toBe(5000);
    expect(sale.derivative).toBe(false);
    expect(buy.code).toBe('P');
    expect(buy.acquiredDisposed).toBe('A');
    expect(exercise.derivative).toBe(true);
    expect(exercise.underlyingSecurity).toBe('Common Stock');
    // Footnote-only price parses to null, so value stays null too.
    expect(exercise.pricePerShare).toBeNull();
    expect(exercise.value).toBeNull();
  });

  it('summarizes only open-market P/S trades', () => {
    const summary = summarizeOpenMarket([filing]);
    expect(summary.openMarketPurchases).toEqual({ transactions: 1, shares: 200, value: 48_000 });
    expect(summary.openMarketSales).toEqual({ transactions: 1, shares: 1000, value: 250_500 });
    // The derivative M exercise (30,104 shares) must not count.
    expect(summary.netShares).toBe(-800);
  });
});

// --- 13F ----------------------------------------------------------------------

const infoRow = (issuer, value, shares, extra = '') => `
  <infoTable>
    <nameOfIssuer>${issuer}</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>${value}</value>
    <shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority><Sole>${shares}</Sole><Shared>0</Shared><None>0</None></votingAuthority>
    ${extra}
  </infoTable>`;

describe('13F parsing', () => {
  it('keeps whole-dollar values when implied prices are sane', () => {
    const xml = `<informationTable>${infoRow('APPLE INC', 498_992_850, 12_719_675)}${infoRow('ALLY FINL', 100_000_000, 2_000_000)}</informationTable>`;
    const table = parseInfoTable(xml, '2026-03-31');
    expect(table.valueUnits).toBe('dollars');
    expect(table.holdings[0].value).toBe(498_992_850);
  });

  it('detects thousands from sub-$1 implied prices and scales', () => {
    // 1,000 (thousands) for 50,000 shares implies $0.02/share — impossible.
    const xml = `<informationTable>${infoRow('APPLE INC', 1000, 50_000)}${infoRow('ALLY FINL', 2000, 80_000)}</informationTable>`;
    const table = parseInfoTable(xml, '2022-09-30');
    expect(table.valueUnits).toBe('thousands');
    expect(table.holdings[0].value).toBe(1_000_000);
  });

  it('handles namespace-prefixed info tables', () => {
    const xml = `<ns1:informationTable><ns1:infoTable><ns1:nameOfIssuer>X</ns1:nameOfIssuer><ns1:value>5000000</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>100000</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt></ns1:infoTable></ns1:informationTable>`;
    const table = parseInfoTable(xml, '2026-03-31');
    expect(table.holdings).toHaveLength(1);
    expect(table.holdings[0].shares).toBe(100_000);
  });

  it('aggregates by (cusip, put/call) so options stay separate', () => {
    const put = infoRow('APPLE INC', 1_000_000, 10_000, '<putCall>Put</putCall>');
    const xml = `<informationTable>${infoRow('APPLE INC', 3_000_000, 20_000)}${infoRow('APPLE INC', 1_000_000, 5000)}${put}</informationTable>`;
    const holdings = aggregateHoldings(parseInfoTable(xml, '2026-03-31').holdings);
    expect(holdings).toHaveLength(2);
    expect(holdings[0].value).toBe(4_000_000); // equity rows merged
    expect(holdings[0].shares).toBe(25_000);
    expect(holdings[1].putCall).toBe('Put'); // option position kept separate
  });

  it('parses the cover page and tolerates a missing summary page', () => {
    const cover = parseCoverPage(
      '<edgarSubmission><headerData/><formData>' +
        '<coverPage><reportCalendarOrQuarter>03-31-2026</reportCalendarOrQuarter>' +
        '<periodOfReport>03-31-2026</periodOfReport>' +
        '<filingManager><name>Test Capital LP</name></filingManager>' +
        '<reportType>13F HOLDINGS REPORT</reportType></coverPage>' +
        '<summaryPage><tableEntryTotal>2</tableEntryTotal><tableValueTotal>599</tableValueTotal></summaryPage>' +
        '</formData></edgarSubmission>',
    );
    expect(cover.manager).toBe('Test Capital LP');
    expect(cover.periodOfReport).toBe('2026-03-31');
    expect(cover.tableValueTotal).toBe(599);

    const bare = parseCoverPage(
      '<edgarSubmission><periodOfReport>12-31-2025</periodOfReport></edgarSubmission>',
    );
    expect(bare.tableValueTotal).toBeNull();
    expect(bare.periodOfReport).toBe('2025-12-31');
  });
});

// --- Filing documents -----------------------------------------------------------

describe('filing documents', () => {
  it('converts SEC HTML to clean text, dropping hidden XBRL and scripts', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body>' +
      '<ix:hidden>MACHINE ONLY</ix:hidden><script>alert(1)</script>' +
      '<p>Para&nbsp;one.</p><div>Second block</div>' +
      '<table><tr><td>Revenue</td><td>$1,000</td></tr></table></body></html>';
    const text = filingHtmlToText(html);
    expect(text).toContain('Para one.\nSecond block');
    expect(text).toContain('Revenue $1,000');
    expect(text).not.toContain('MACHINE ONLY');
    expect(text).not.toContain('alert');
  });

  it('finds literal matches with offsets and context', () => {
    const text = `${'x'.repeat(500)} the Risk Factors begin here ${'y'.repeat(500)}`;
    const matches = findInText(text, 'risk factors');
    expect(matches).toHaveLength(1);
    expect(matches[0].offset).toBe(505);
    expect(matches[0].context).toContain('Risk Factors begin here');
  });

  it('picks the declared primary document, stripping XSL viewer prefixes', () => {
    const entries = [
      { name: 'form4.xml', size: 8000, extension: 'xml' },
      { name: 'report.htm', size: 90_000, extension: 'htm' },
    ];
    expect(pickPrimaryDocument(entries, 'xslF345X06/form4.xml')?.name).toBe('form4.xml');
  });

  it('falls back to the largest non-exhibit HTML document', () => {
    const entries = [
      { name: 'ex-991.htm', size: 900_000, extension: 'htm' },
      { name: 'a10-k.htm', size: 500_000, extension: 'htm' },
      { name: 'small.htm', size: 100, extension: 'htm' },
    ];
    expect(pickPrimaryDocument(entries)?.name).toBe('a10-k.htm');
  });

  it('falls back to a lone .txt for very old filings', () => {
    const entries = [{ name: '0000320193-99-000001.txt', size: 50_000, extension: 'txt' }];
    expect(pickPrimaryDocument(entries)?.name).toBe('0000320193-99-000001.txt');
  });
});
