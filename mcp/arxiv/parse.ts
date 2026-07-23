/**
 * Pure parsers for arXiv's wire formats: the shared text helpers, the Atom
 * feed reader (paper metadata), and the LaTeXML HTML reader (full text +
 * references). arXiv returns Atom XML (not JSON) and the LaTeXML full-text is
 * HTML, and the runtime has no DOMParser, so both are parsed with string/regex
 * extraction below. Nothing here touches the network.
 */

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace to single spaces and trim. */
function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Decode the XML/HTML entities arXiv and LaTeXML emit (named + numeric). */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/** Safely turn a code point into a string, dropping invalid ones. */
function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * Collapse every `<math>` element to a single `$…$` LaTeX span.
 *
 * LaTeXML renders each formula TWICE inside one `<math>`: as MathML glyph
 * elements for display, and again as an `<annotation encoding="application/x-tex">`
 * holding the source. A blanket tag strip keeps both, so every formula landed
 * in the text doubled — "β 0 ​ ( t ) \beta_{0}(t)", "0.82 =0.82 – 0.90 0.90" —
 * inflating a paper by ~7% with unreadable noise that also polluted its
 * embeddings. Prefer the element's `alttext` (clean, already the TeX source);
 * fall back to the inner annotation, and finally to the rendered glyphs for
 * math that carries neither.
 */
function collapseMath(html: string): string {
  return html.replace(
    /<math\b([^>]*)>([\s\S]*?)<\/math>/gi,
    (_full, attrs: string, inner: string) => {
      const alt = /\balttext="([^"]*)"/i.exec(attrs)?.[1];
      const tex =
        alt ??
        /<annotation\b[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>/i.exec(
          inner,
        )?.[1];
      // No TeX anywhere: keep the rendered glyphs, minus any annotation, so the
      // content survives rather than vanishing.
      if (tex === undefined) {
        return ` ${inner.replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gi, ' ')} `;
      }
      const clean = squish(decodeEntities(tex));
      return clean ? ` $${clean}$ ` : ' ';
    },
  );
}

/** Strip HTML/XML tags to plain text (dropping script/style), then decode + squish. */
function htmlToText(html: string): string {
  const stripped = collapseMath(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return squish(decodeEntities(stripped));
}

// ---------------------------------------------------------------------------
// Atom feed parsing (metadata)
// ---------------------------------------------------------------------------

export interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  categories: string[];
  pdfUrl: string;
  arxivUrl: string;
}

/** Extract the inner text of the first `<tag>...</tag>` in `xml`, or `''`. */
function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] ? decodeEntities(squish(match[1])) : '';
}

/** Reduce a full arXiv id URL to its bare identifier ("...abs/2510.25417v1" → "2510.25417"). */
function bareId(idUrl: string): string {
  const match = /abs\/(.+?)(?:v\d+)?$/.exec(idUrl);
  return match?.[1] ?? idUrl;
}

/** Parse a single `<entry>...</entry>` block into an {@link ArxivPaper}. */
function parseEntry(entry: string): ArxivPaper {
  const id = bareId(tagText(entry, 'id'));

  const authors: string[] = [];
  const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/g;
  for (let m = authorRe.exec(entry); m !== null; m = authorRe.exec(entry)) {
    const name = tagText(m[1] ?? '', 'name');
    if (name) authors.push(name);
  }

  const categories: string[] = [];
  const catRe = /<category\b[^>]*\bterm="([^"]*)"/g;
  for (let m = catRe.exec(entry); m !== null; m = catRe.exec(entry)) {
    if (m[1]) categories.push(decodeEntities(m[1]));
  }

  const pdfRe =
    /<link\b[^>]*\btitle="pdf"[^>]*\bhref="([^"]*)"|<link\b[^>]*\bhref="([^"]*)"[^>]*\btitle="pdf"/;
  const pdfMatch = pdfRe.exec(entry);
  const pdfUrl = pdfMatch?.[1] ?? pdfMatch?.[2] ?? `https://arxiv.org/pdf/${id}`;

  return {
    id,
    title: tagText(entry, 'title'),
    authors,
    summary: tagText(entry, 'summary'),
    published: tagText(entry, 'published'),
    updated: tagText(entry, 'updated'),
    categories,
    pdfUrl,
    arxivUrl: `https://arxiv.org/abs/${id}`,
  };
}

/** Split an Atom feed into its `<entry>` blocks and parse each one. */
export function parseFeed(xml: string): ArxivPaper[] {
  const entries: ArxivPaper[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  for (let m = entryRe.exec(xml); m !== null; m = entryRe.exec(xml)) {
    const paper = parseEntry(m[1] ?? '');
    // arXiv returns an error stub entry (no real id/title) for bad queries.
    if (paper.id && paper.title) entries.push(paper);
  }
  return entries;
}

/** Total match count arXiv reports for the query (for pagination), or 0. */
export function totalResults(xml: string): number {
  const match = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(xml);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

// ---------------------------------------------------------------------------
// LaTeXML HTML parsing (full text + references — feedback pts 1, 7)
// ---------------------------------------------------------------------------

export type SectionKind =
  | 'introduction'
  | 'background'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'other';

export interface PaperSection {
  title: string;
  kind: SectionKind;
  text: string;
}

export interface PaperContent {
  abstract: string;
  sections: PaperSection[];
  references: string[];
  citedArxivIds: string[];
}

/** Classify a section by its heading so an agent can ask for just "results". */
function classifySection(title: string): SectionKind {
  const t = title.toLowerCase();
  if (/introduction/.test(t)) return 'introduction';
  if (/related work|background|preliminar/.test(t)) return 'background';
  if (/method|approach|architecture|model|experimental setup|dataset/.test(t)) return 'methods';
  if (/result|evaluation|experiment|finding|ablation/.test(t)) return 'results';
  if (/discussion|analysis|limitation/.test(t)) return 'discussion';
  if (/conclusion|future work|summary/.test(t)) return 'conclusion';
  return 'other';
}

/** Pull arXiv ids out of reference text, for citation-graph traversal. */
function extractArxivIds(references: string[]): string[] {
  const ids = new Set<string>();
  const re = /(?:arxiv:\s*|abs\/|\/)?\b(\d{4}\.\d{4,5})(?:v\d+)?\b/gi;
  for (const ref of references) {
    for (let m = re.exec(ref); m !== null; m = re.exec(ref)) {
      if (m[1]) ids.add(m[1]);
    }
  }
  return [...ids];
}

/** Extract the abstract block's text (its heading stripped), or `''`. */
function parseAbstract(html: string): string {
  const absMatch = /<div\b[^>]*\bclass="[^"]*\bltx_abstract\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
    html,
  );
  return absMatch
    ? htmlToText((absMatch[1] ?? '').replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i, ''))
    : '';
}

/**
 * Locate the bibliography; references live from its offset to end-of-document.
 * Returns `matched: false` (and the full length) when a paper has no bibliography.
 */
function locateBibliography(html: string): { matched: boolean; at: number } {
  const match =
    /<section\b[^>]*\bclass="[^"]*\bltx_bibliography\b[^"]*"/i.exec(html) ??
    /<(?:section|div|ul)\b[^>]*\bclass="[^"]*\bltx_biblist\b[^"]*"/i.exec(html);
  return { matched: match !== null, at: match ? match.index : html.length };
}

/**
 * Split body HTML into titled top-level sections; papers whose HTML lacks
 * section markup degrade to a single "Full text" section.
 */
function parseSections(body: string): PaperSection[] {
  const headingRe = /<h2\b[^>]*\bclass="[^"]*\bltx_title_section\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi;
  const heads: { title: string; start: number; end: number }[] = [];
  for (let m = headingRe.exec(body); m !== null; m = headingRe.exec(body)) {
    const title = htmlToText(m[1] ?? '').replace(/^\d+(?:\.\d+)*\s*/, '');
    heads.push({ title, start: m.index, end: headingRe.lastIndex });
  }

  if (heads.length === 0) {
    const text = htmlToText(body);
    return text ? [{ title: 'Full text', kind: 'other', text }] : [];
  }

  const sections: PaperSection[] = [];
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i]?.end ?? 0;
    const to = heads[i + 1]?.start ?? body.length;
    const text = htmlToText(body.slice(from, to));
    const title = heads[i]?.title ?? 'Section';
    if (text) sections.push({ title, kind: classifySection(title), text });
  }
  return sections;
}

/** Parse the reference list out of the bibliography portion of the HTML. */
function parseReferences(biblioHtml: string): string[] {
  const references: string[] = [];
  const bibRe = /<li\b[^>]*\bclass="[^"]*\bltx_bibitem\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (let m = bibRe.exec(biblioHtml); m !== null; m = bibRe.exec(biblioHtml)) {
    const ref = htmlToText(m[1] ?? '');
    if (ref) references.push(ref);
  }
  return references;
}

/**
 * Parse LaTeXML full-text HTML (from arXiv's HTML view or ar5iv) into an
 * abstract, titled sections, and the reference list. Best-effort: papers whose
 * HTML lacks section markup degrade to a single "Full text" section.
 */
export function parseHtmlContent(html: string): PaperContent {
  const abstract = parseAbstract(html);
  // The bibliography ends the body; references live after it.
  const biblio = locateBibliography(html);
  const sections = parseSections(html.slice(0, biblio.at));
  const references = biblio.matched ? parseReferences(html.slice(biblio.at)) : [];
  return { abstract, sections, references, citedArxivIds: extractArxivIds(references) };
}
