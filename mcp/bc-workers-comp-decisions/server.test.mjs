import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const wcatItem = (number, date, issue) => `
  <li>
    <div class="wcat-theme-search__header">
      <div><div class="h4">Appeal or decision number</div>
        <div><a href="https://www.wcat.bc.ca/decisions/pdf/2022/04/${number}.pdf" target="__blank">${number}</a></div></div>
      <div><div class="h4">Date</div><div>${date}</div></div>
    </div>
    <div class="h4">Appeal or application type</div><div>Compensation</div>
    <div class="h4">Decision or document type</div><div>Merit</div>
    <div class="h4">Issues under appeal</div><p>${issue}</p>
  </li>`;

const wcatPage = (items) => `<html><body><ul>${items.join('')}</ul></body></html>`;

// Serve a first WCAT page then empty pages (pagination terminator).
const wcatResponder = (items) => (url) => ({
  text: /\/page\/[2-9]/.test(url) ? wcatPage([]) : wcatPage(items),
});

const WSBC_LANDING = {
  text: '<form id="SearchForm"><input name="__RequestVerificationToken" value="TOK123" /></form>',
  headers: { 'set-cookie': '.AspNetCore.Antiforgery.abc=cookieval; path=/; httponly' },
};
const wsbcRow = (number, snippet, date) =>
  `<tr id="row-0"><td>${number}</td><td><div class="snippet">${snippet}</div></td><td>${date}</td><td><a href="/Home/Document?index=0">view</a></td></tr>`;
const wsbcSearch = (rows, total) => ({
  text: `<html><body><span>${total} results</span><table>${rows.join('')}</table></body></html>`,
});
const wsbcResponder = (rows, total) => (_url, init) =>
  init?.method === 'POST' ? wsbcSearch(rows, total) : WSBC_LANDING;

// Real WorkSafeBC flow: POST 302-redirects to "/" with a new session cookie; the
// results only appear on the followed GET carrying that cookie (Post-Redirect-Get).
const wsbcPrgResponder = (rows, total) => {
  let gets = 0;
  return (_url, init) => {
    if (init?.method === 'POST') {
      return {
        status: 302,
        headers: { 'set-cookie': '.AspNetCore.Session=sess1; path=/', location: '/' },
      };
    }
    gets += 1;
    return gets === 1 ? WSBC_LANDING : wsbcSearch(rows, total);
  };
};

describe('bc-workers-comp-decisions MCP server', () => {
  it('lists the three tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_wcat_decision',
      'search_review_decisions',
      'search_wcat_decisions',
    ]);
  });

  describe('search_wcat_decisions', () => {
    it('parses decisions and links to the PDF', async () => {
      const r = await callTool(
        server,
        'search_wcat_decisions',
        { query: '"wrist fracture"' },
        // numeric (&#39;) + hex (&#x2014;) entities exercise htmlToText's decoders
        wcatResponder([
          wcatItem(
            'A2002996',
            'Apr 07, 2022',
            'Did the worker&#39;s wrist&#x2014;fracture resolve?',
          ),
        ]),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.count).toBe(1);
      const d = r.result.structured.decisions[0];
      expect(d.number).toBe('A2002996');
      expect(d.date).toBe(new Date('Apr 07, 2022 UTC').toISOString());
      expect(d.applicationType).toBe('Compensation');
      expect(d.issues).toBe("Did the worker's wrist—fracture resolve?");
      expect(d.pdfUrl).toBe('https://www.wcat.bc.ca/decisions/pdf/2022/04/A2002996.pdf');
      expect(r.result.text).toContain('A2002996');
    });

    it('puts a classification facet on the query URL and allows an empty query', async () => {
      let seenUrl = '';
      const r = await callTool(
        server,
        'search_wcat_decisions',
        { classification: 'precedent' },
        (url) => {
          seenUrl = url;
          return {
            text: /\/page\/[2-9]/.test(url)
              ? wcatPage([])
              : wcatPage([wcatItem('2007-04002', 'Dec 20, 2007', 'x')]),
          };
        },
      );
      expect(r.ok).toBe(true);
      expect(seenUrl).toContain('classification=precedent');
      expect(seenUrl).toContain('sortby=date');
    });

    it('errors when neither query nor a facet is provided', async () => {
      const r = await callTool(server, 'search_wcat_decisions', {});
      expect(r.ok).toBe(false);
    });

    it('reports no matches cleanly', async () => {
      const r = await callTool(
        server,
        'search_wcat_decisions',
        { query: 'zzz' },
        wcatResponder([]),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.count).toBe(0);
    });
  });

  describe('get_wcat_decision', () => {
    it('looks up a decision by number', async () => {
      const r = await callTool(
        server,
        'get_wcat_decision',
        { number: 'A2002996' },
        wcatResponder([wcatItem('A2002996', 'Apr 07, 2022', 'issue')]),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.found).toBe(true);
      expect(r.result.structured.decision.number).toBe('A2002996');
    });

    it('reports not-found', async () => {
      const r = await callTool(
        server,
        'get_wcat_decision',
        { number: 'A9999999' },
        wcatResponder([]),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.found).toBe(false);
      expect(r.result.structured.decision).toBeNull();
    });
  });

  describe('search_review_decisions', () => {
    it('gets a token, posts a search, and parses rows', async () => {
      const r = await callTool(
        server,
        'search_review_decisions',
        { keyword: '"scaphoid fracture"' },
        wsbcResponder([wsbcRow('R0295253', 'severe right wrist fracture', '2023-01-05')], 184),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.count).toBe(1);
      expect(r.result.structured.total).toBe(184);
      expect(r.result.structured.truncated).toBe(false);
      const d = r.result.structured.decisions[0];
      expect(d.number).toBe('R0295253');
      expect(d.date).toBe(new Date('2023-01-05').toISOString());
      expect(d.snippet).toContain('wrist fracture');
    });

    it('follows the Post-Redirect-Get flow and reads the results page', async () => {
      const r = await callTool(
        server,
        'search_review_decisions',
        { keyword: '"scaphoid fracture"', limit: 5 },
        wsbcPrgResponder([wsbcRow('R0295253', 'wrist fracture', '2023-01-05')], 42),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.count).toBe(1);
      expect(r.result.structured.total).toBe(42);
      expect(r.result.structured.decisions[0].number).toBe('R0295253');
    });

    it('flags truncation at the 1000-result cap', async () => {
      const r = await callTool(
        server,
        'search_review_decisions',
        { keyword: 'fracture' },
        wsbcResponder([wsbcRow('R0300000', 'x', '2024-01-01')], 1000),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.truncated).toBe(true);
    });

    it('reports no matches cleanly', async () => {
      const r = await callTool(
        server,
        'search_review_decisions',
        { keyword: 'zzz' },
        wsbcResponder([], 0),
      );
      expect(r.ok).toBe(true);
      expect(r.result.structured.count).toBe(0);
    });
  });
});
