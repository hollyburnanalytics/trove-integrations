import { type ToolDefinition, z } from '@ontrove/mcp';
import { authorLine, fetchPaper, fetchPaperHtml } from '../papers.ts';
import { parseHtmlContent } from '../parse.ts';

/** `get_paper_content` — read a paper's full text as labelled sections + refs. */
export const getPaperContent: ToolDefinition = {
  name: 'get_paper_content',
  title: 'arXiv: Read full text',
  description:
    "Read a paper's full text — parsed from arXiv's HTML (or ar5iv) into titled, " +
    'labelled sections (introduction / methods / results / conclusion …), plus its ' +
    'reference list and the arXiv ids it cites (for citation traversal). Pass a ' +
    '`section` to retrieve just that part (e.g. "results") instead of the whole paper. ' +
    'Not every paper has an HTML version; older PDF-only papers fall back to the abstract.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    id: z.string().min(1).describe('arXiv paper id, e.g. "2510.25417".'),
    section: z
      .enum(['introduction', 'background', 'methods', 'results', 'discussion', 'conclusion'])
      .optional()
      .describe('Return only sections of this kind (matched by heading) instead of all.'),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(200_000)
      .default(60_000)
      .describe('Cap on total returned body text (default 60000). Sections are truncated to fit.'),
  }),
  output: z.object({
    id: z.string(),
    title: z.string(),
    htmlAvailable: z.boolean(),
    abstract: z.string(),
    sections: z.array(z.object({ title: z.string(), kind: z.string(), text: z.string() })),
    availableSections: z.array(z.object({ title: z.string(), kind: z.string() })),
    references: z.array(z.string()),
    citedArxivIds: z.array(z.string()),
    truncated: z.boolean(),
  }),
  async handler(args, ctx) {
    const { id, section, maxChars } = args;
    ctx.log('get_paper_content fetching', { id, section });

    const paper = await fetchPaper(ctx, id);
    const html = await fetchPaperHtml(ctx, id);

    if (!html) {
      return {
        text:
          `${paper.id} — ${paper.title}\nNo HTML full text is available for this paper ` +
          `(older submissions are PDF-only). Abstract:\n\n${paper.summary}\nPDF: ${paper.pdfUrl}`,
        structured: {
          id: paper.id,
          title: paper.title,
          htmlAvailable: false,
          abstract: paper.summary,
          sections: [],
          availableSections: [],
          references: [],
          citedArxivIds: [],
          truncated: false,
        },
      };
    }

    const content = parseHtmlContent(html);
    const availableSections = content.sections.map((s) => ({ title: s.title, kind: s.kind }));
    let sections = content.sections;
    if (section) sections = sections.filter((s) => s.kind === section);

    // A requested section the paper doesn't have (common — not every paper
    // uses canonical headings): return the sections it DOES have so the
    // caller can re-request, rather than an empty, silent result.
    if (section && sections.length === 0 && content.sections.length > 0) {
      const list = availableSections.map((s) => `${s.title} (${s.kind})`).join('; ');
      return {
        text: `${paper.id} — ${paper.title}\nNo section is classified as "${section}". Available sections: ${list}. Re-run with one of those kinds, or omit "section" for the whole paper.`,
        structured: {
          id: paper.id,
          title: paper.title,
          htmlAvailable: true,
          abstract: content.abstract || paper.summary,
          sections: [],
          availableSections,
          references: content.references,
          citedArxivIds: content.citedArxivIds,
          truncated: false,
        },
      };
    }

    // Budget the total body text across the selected sections.
    let remaining = maxChars;
    let truncated = false;
    const budgeted = sections.map((s) => {
      if (remaining <= 0) {
        truncated = true;
        return { ...s, text: '' };
      }
      if (s.text.length > remaining) {
        truncated = true;
        const text = `${s.text.slice(0, remaining).trimEnd()}…`;
        remaining = 0;
        return { ...s, text };
      }
      remaining -= s.text.length;
      return s;
    });
    const kept = budgeted.filter((s) => s.text);

    const headerLines = section
      ? `${paper.id} — ${paper.title}\nSection(s): ${section}`
      : `${paper.id} — ${paper.title}\n${authorLine(paper.authors)} · ${kept.length} section(s) · ${content.references.length} reference(s)`;
    const bodyText = kept.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');

    return {
      text: `${headerLines}\n\n${bodyText || content.abstract}${truncated ? '\n\n(text truncated — raise maxChars or request one section)' : ''}`,
      structured: {
        id: paper.id,
        title: paper.title,
        htmlAvailable: true,
        abstract: content.abstract || paper.summary,
        sections: kept,
        availableSections,
        references: content.references,
        citedArxivIds: content.citedArxivIds,
        truncated,
      },
    };
  },
};
