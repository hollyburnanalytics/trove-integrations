import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

/** Build a single Atom <entry> block in the shape arXiv emits. */
function entry({
  id = '2510.25417',
  title = 'A Study of Diffusion Models',
  authors = ['Ada Lovelace', 'Alan Turing'],
  summary = 'We present a thorough study of diffusion models.',
  published = '2025-10-29T12:00:00Z',
  updated = '2025-10-30T08:00:00Z',
  categories = ['cs.LG', 'stat.ML'],
} = {}) {
  const authorXml = authors.map((n) => `<author><name>${n}</name></author>`).join('\n');
  const catXml = categories
    .map((c) => `<category term="${c}" scheme="http://arxiv.org/schemas/atom"/>`)
    .join('\n');
  return `<entry>
    <id>http://arxiv.org/abs/${id}v1</id>
    <updated>${updated}</updated>
    <published>${published}</published>
    <title>${title}</title>
    <summary>${summary}</summary>
    ${authorXml}
    <link href="http://arxiv.org/abs/${id}v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${id}v1" rel="related" type="application/pdf"/>
    ${catXml}
  </entry>`;
}

/** Wrap entry blocks in an Atom feed with an optional total-results count. */
function feed(entries = [], total) {
  const count = total ?? entries.length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>${count}</opensearch:totalResults>
  ${entries.join('\n')}
</feed>`;
}

/** A minimal LaTeXML full-text document (arXiv HTML / ar5iv shape). */
function htmlDocument() {
  return `<!DOCTYPE html><html><body><div class="ltx_page_content">
  <div class="ltx_abstract"><h6 class="ltx_title">Abstract</h6>
    <p class="ltx_p">This is the abstract text.</p></div>
  <section class="ltx_section" id="S1">
    <h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>
    <div class="ltx_para"><p class="ltx_p">Intro paragraph about the problem.</p></div></section>
  <section class="ltx_section" id="S2">
    <h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">2 </span>Results</h2>
    <div class="ltx_para"><p class="ltx_p">We achieved strong results on the benchmark.</p></div></section>
  <section class="ltx_bibliography" id="bib">
    <h2 class="ltx_title ltx_title_bibliography">References</h2>
    <ul class="ltx_biblist">
      <li class="ltx_bibitem" id="bib.bib1"><span class="ltx_bibblock">Prior work, arXiv:2401.12345.</span></li>
    </ul></section>
  </div></body></html>`;
}

/** Responder that serves the metadata feed and (optionally) HTML full text. */
function paperResponder({ atom, arxivHtml, ar5ivHtml, onIngest, onFetch } = {}) {
  return (url, init) => {
    if (url.includes('/internal/trove')) {
      onIngest?.(JSON.parse(init.body));
      return { json: { data: { ingested: 1 } } };
    }
    // Every request that actually leaves for arXiv. A save is supposed to make
    // as few of these as possible — ideally none.
    onFetch?.(url);
    if (url.includes('export.arxiv.org/api/query')) return { text: atom ?? feed([entry()]) };
    if (url.includes('//arxiv.org/html/')) return arxivHtml ?? { status: 404 };
    if (url.includes('ar5iv')) return ar5ivHtml ?? { status: 404 };
    return { status: 404 };
  };
}

describe('arxiv MCP server', () => {
  it('lists the four tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_paper',
      'get_paper_content',
      'save_paper',
      'search_papers',
    ]);
  });

  describe('search_papers', () => {
    it('returns parsed papers for a query', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'diffusion models', category: 'cs.LG', maxResults: 10 },
        {
          text: feed(
            [
              entry({ id: '2510.25417', title: 'Diffusion Models Survey' }),
              entry({ id: '2510.11111' }),
            ],
            2,
          ),
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      const [first] = result.result.structured.papers;
      expect(first.id).toBe('2510.25417');
      expect(first.pdfUrl).toContain('arxiv.org/pdf/2510.25417v1');
    });

    it('composes field-scoped clauses with the literal +AND+ joiner', async () => {
      let requested = '';
      await callTool(
        server,
        'search_papers',
        { title: 'graph neural', author: 'hinton', category: 'cs.LG' },
        (url) => {
          requested = url;
          return { text: feed([entry()]) };
        },
      );
      expect(requested).toContain('ti:graph%20neural+AND+au:hinton+AND+cat:cs.LG');
    });

    it('compiles from_date/to_date into a submittedDate range', async () => {
      let requested = '';
      await callTool(
        server,
        'search_papers',
        { query: 'dementia', from_date: '2026', to_date: '2026-06' },
        (url) => {
          requested = url;
          return { text: feed([entry()]) };
        },
      );
      expect(requested).toContain('submittedDate:[20260101+TO+20260630]');
    });

    it('uses the real last day of a leap-year month', async () => {
      let requested = '';
      await callTool(server, 'search_papers', { query: 'dementia', to_date: '2024-02' }, (url) => {
        requested = url;
        return { text: feed([entry()]) };
      });
      expect(requested).toContain('submittedDate:[19910101+TO+20240229]');
    });

    it('rejects impossible dates before calling arXiv', async () => {
      const result = await callTool(server, 'search_papers', {
        query: 'dementia',
        to_date: '2026-02-31',
      });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/could not parse the date/i);
    });

    it('treats a `query` that is ALREADY arXiv grammar as arXiv grammar', async () => {
      // `query` wraps its input in `all:` and percent-encodes it — so `ti:Kafka`,
      // the syntax arXiv itself documents, went out as `all:ti%3AKafka` and came
      // back 400. The tool then said only "arXiv rejected the search query": true,
      // unhelpful, and blaming the caller for a query they had written correctly.
      // Two people fell into this on the same afternoon, which makes it ours.
      let requested = '';
      await callTool(
        server,
        'search_papers',
        { query: 'ti:Kafka OR abs:"Apache Kafka"' },
        (url) => {
          requested = url;
          return { text: feed([entry()]) };
        },
      );
      expect(requested).toContain('search_query=ti:Kafka+OR+abs:"Apache+Kafka"');
      expect(requested).not.toContain('all:ti%3A');
    });

    it('still treats ordinary words as ordinary words', async () => {
      // The heuristic must not steal a plain search that merely contains a colon
      // or the word "and".
      let requested = '';
      await callTool(server, 'search_papers', { query: 'attention and transformers' }, (url) => {
        requested = url;
        return { text: feed([entry()]) };
      });
      expect(requested).toContain('search_query=all:attention%20and%20transformers');
    });

    it('passes a raw advanced expression through, overriding the fields', async () => {
      let requested = '';
      await callTool(
        server,
        'search_papers',
        { query: 'ignored', advanced: 'ti:transformer ANDNOT abs:vision' },
        (url) => {
          requested = url;
          return { text: feed([entry()]) };
        },
      );
      expect(requested).toContain('search_query=ti:transformer+ANDNOT+abs:vision');
      expect(requested).not.toContain('ignored');
    });

    it('reports pagination when more results remain', async () => {
      const result = await callTool(
        server,
        'search_papers',
        { query: 'x', maxResults: 2, start: 0 },
        { text: feed([entry({ id: '1' }), entry({ id: '2' })], 10) },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.hasMore).toBe(true);
      expect(result.result.structured.nextStart).toBe(2);
      expect(result.result.structured.total).toBe(10);
    });

    it('errors when no search parameter is supplied', async () => {
      const result = await callTool(server, 'search_papers', {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
    });

    it('rejects maxResults above the allowed maximum', async () => {
      const result = await callTool(server, 'search_papers', { query: 'x', maxResults: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('surfaces a distinct retryable error on HTTP 429', async () => {
      const result = await callTool(server, 'search_papers', { query: 'busy' }, { status: 429 });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/rate-limit/i);
    });

    it('serves an identical repeat query from the in-isolate cache', async () => {
      let calls = 0;
      const responder = (url) => {
        if (url.includes('export.arxiv.org')) calls++;
        return { text: feed([entry()]) };
      };
      const arguments_ = { query: 'zzz-unique-cache-probe' };
      await callTool(server, 'search_papers', arguments_, responder);
      await callTool(server, 'search_papers', arguments_, responder);
      expect(calls).toBe(1);
    });
  });

  describe('get_paper', () => {
    it('returns a single paper by id', async () => {
      const result = await callTool(
        server,
        'get_paper',
        { id: '2510.10001' },
        { text: feed([entry({ id: '2510.10001', title: 'A Single Paper' })]) },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.id).toBe('2510.10001');
      expect(result.result.text).toContain('A Single Paper');
    });

    it('maps an empty feed to a non-retryable not-found error', async () => {
      const result = await callTool(server, 'get_paper', { id: '0000.00000' }, { text: feed([]) });
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no arxiv paper found/i);
    });
  });

  // Distinct ids per test: identical requests are cached across the run.
  describe('get_paper_content', () => {
    it('parses HTML into labelled sections, references and cited ids', async () => {
      const result = await callTool(
        server,
        'get_paper_content',
        { id: '2510.20001' },
        paperResponder({ arxivHtml: { text: htmlDocument() } }),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.htmlAvailable).toBe(true);
      expect(s.abstract).toBe('This is the abstract text.');
      expect(s.sections.map((x) => x.kind)).toEqual(['introduction', 'results']);
      expect(s.sections[1].text).toContain('strong results');
      expect(s.references).toHaveLength(1);
      expect(s.citedArxivIds).toEqual(['2401.12345']);
    });

    it('returns only the requested section kind', async () => {
      const result = await callTool(
        server,
        'get_paper_content',
        { id: '2510.20002', section: 'results' },
        paperResponder({ arxivHtml: { text: htmlDocument() } }),
      );
      expect(result.result.structured.sections).toHaveLength(1);
      expect(result.result.structured.sections[0].kind).toBe('results');
    });

    it('lists available sections when the requested kind is absent', async () => {
      const result = await callTool(
        server,
        'get_paper_content',
        { id: '2510.20005', section: 'methods' },
        paperResponder({ arxivHtml: { text: htmlDocument() } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.sections).toEqual([]);
      expect(result.result.structured.availableSections.map((s) => s.kind)).toEqual([
        'introduction',
        'results',
      ]);
      expect(result.result.text).toMatch(/no section is classified as "methods"/i);
    });

    it('falls back to ar5iv when arXiv HTML is missing', async () => {
      const result = await callTool(
        server,
        'get_paper_content',
        { id: '2510.20003' },
        paperResponder({ arxivHtml: { status: 404 }, ar5ivHtml: { text: htmlDocument() } }),
      );
      expect(result.result.structured.htmlAvailable).toBe(true);
      expect(result.result.structured.sections).toHaveLength(2);
    });

    it('degrades to the abstract when no HTML version exists', async () => {
      const result = await callTool(
        server,
        'get_paper_content',
        { id: '2510.20004' },
        paperResponder({
          atom: feed([entry({ id: '2510.20004', summary: 'Only the abstract.' })]),
          arxivHtml: { status: 404 },
          ar5ivHtml: { status: 404 },
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.htmlAvailable).toBe(false);
      expect(result.result.structured.abstract).toBe('Only the abstract.');
    });
  });

  describe('save_paper', () => {
    it('ingests the paper into the knowledge base when granted trove:ingest', async () => {
      let ingested;
      const result = await callTool(
        server,
        'save_paper',
        { id: '2510.30001' },
        paperResponder({
          atom: feed([entry({ id: '2510.30001', title: 'Saved Paper' })]),
          onIngest: (body) => {
            ingested = body;
          },
        }),
        ['trove:ingest'],
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.ingested).toBe(1);
      expect(result.result.structured.includedFullText).toBe(false);
      expect(ingested.operation).toBe('ingest');
      const [document] = ingested.variables.documents;
      expect(document.title).toBe('Saved Paper');
      expect(document.url).toBe('https://arxiv.org/abs/2510.30001');
      expect(document.text).toContain('arXiv:2510.30001');
      // Grouped into a feed by the paper's primary arXiv category.
      expect(document.feed).toEqual({ key: 'cs.LG', name: 'cs.LG', label: 'Category' });
      // Dated by the paper's own submission date, NOT the moment it was saved —
      // otherwise every paper in the library looks like it came out today.
      expect(document.date).toBe('2025-10-29T12:00:00Z');
      // The dedup key — saving the same paper twice must not make two documents.
      expect(document.externalId).toBe('2510.30001');
    });

    it('sends the HTML url with the PDF as the server-side fallback — and probes NOTHING', async () => {
      // The save used to make three arXiv requests: the metadata, then two HEAD
      // probes to find out whether the paper had rendered HTML. The platform
      // cancels a tool call at about eight seconds, and each of those requests sits
      // behind a three-second politeness throttle — so when arXiv slowed under a
      // burst, one of them could spend the entire window and the caller was told
      // "tool timed out or crashed".
      //
      // "Does this paper have HTML?" is a question the SERVER can answer, in a
      // Workflow nobody is waiting on. We hand it both URLs and let it find out.
      let ingested;
      const calls = [];
      const result = await callTool(
        server,
        'save_paper',
        { id: '2510.30005' },
        paperResponder({
          atom: feed([entry({ id: '2510.30005' })]),
          onFetch: (url) => calls.push(String(url)),
          onIngest: (b) => {
            ingested = b;
          },
        }),
        ['trove:ingest'],
      );

      const [document] = ingested.variables.documents;
      expect(document.fileUrl).toBe('https://arxiv.org/html/2510.30005');
      expect(document.mimeType).toBe('text/html');
      // The fallback the server takes when the paper has no rendered HTML. Every
      // arXiv paper has a PDF, so a save can always capture the paper itself.
      expect(document.fallback.fileUrl).toContain('/pdf/');
      expect(document.fallback.mimeType).toBe('application/pdf');
      expect(result.result.structured.captured).toBe('html-or-pdf');

      // NOT ONE request to arxiv.org/html or ar5iv. That is the whole point.
      expect(calls.filter((u) => u.includes('/html/'))).toHaveLength(0);
    });

    it('makes NO arXiv request at all when the caller passes the paper it already has', async () => {
      // The metadata came from search_papers moments ago. Re-fetching it is what
      // makes a burst of saves slow enough to be cancelled — so a caller that has
      // it can hand it over, and the save costs zero arXiv round-trips.
      let ingested;
      const calls = [];
      const paper = {
        id: '2510.30005',
        title: 'A Paper',
        authors: ['A. Author'],
        summary: 'We show a thing.',
        published: '2025-10-30T00:00:00Z',
        updated: '2025-10-30T00:00:00Z',
        categories: ['cs.CL'],
        pdfUrl: 'https://arxiv.org/pdf/2510.30005v1',
        arxivUrl: 'https://arxiv.org/abs/2510.30005',
      };

      const result = await callTool(
        server,
        'save_paper',
        { id: '2510.30005', paper },
        paperResponder({
          atom: feed([entry({ id: '2510.30005' })]),
          onFetch: (url) => calls.push(String(url)),
          onIngest: (b) => {
            ingested = b;
          },
        }),
        ['trove:ingest'],
      );

      expect(calls).toHaveLength(0);
      const [document] = ingested.variables.documents;
      expect(document.title).toBe('A Paper');
      expect(document.text).toContain('We show a thing.');
      expect(result.result.structured.id).toBe('2510.30005');
    });

    it('indexes full text when includeFullText is set', async () => {
      let ingested;
      const result = await callTool(
        server,
        'save_paper',
        { id: '2510.30002', includeFullText: true },
        paperResponder({
          atom: feed([entry({ id: '2510.30002' })]),
          arxivHtml: { text: htmlDocument() },
          onIngest: (b) => {
            ingested = b;
          },
        }),
        ['trove:ingest'],
      );
      expect(result.result.structured.includedFullText).toBe(true);
      expect(ingested.variables.documents[0].text).toContain('strong results');
    });

    it('errors clearly when the trove:ingest scope is not granted', async () => {
      const result = await callTool(
        server,
        'save_paper',
        { id: '2510.30003' },
        paperResponder({ atom: feed([entry({ id: '2510.30003' })]) }),
      );
      expect(result.ok).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/trove:ingest|permission/i);
    });
  });
});
