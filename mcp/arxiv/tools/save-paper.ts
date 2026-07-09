import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { fetchPaper, fetchPaperHtml } from '../papers.ts';
import { parseHtmlContent } from '../parse.ts';

/** `save_paper` — ingest an arXiv paper into the Trove knowledge base. */
export const savePaper: ToolDefinition = {
  name: 'save_paper',
  title: 'arXiv: Save to knowledge base',
  description:
    'Save an arXiv paper into your Trove knowledge base so you can find it later with ' +
    'a normal Trove search (no re-fetch). Stores the title, authors, abstract, arXiv id, ' +
    'categories and link; set includeFullText to also index the parsed body sections.',
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: z.object({
    id: z.string().min(1).describe('arXiv paper id to save, e.g. "2510.25417".'),
    includeFullText: z
      .boolean()
      .default(false)
      .describe('Also fetch and index the full body text (when an HTML version exists).'),
  }),
  output: z.object({
    id: z.string(),
    title: z.string(),
    ingested: z.number(),
    includedFullText: z.boolean(),
  }),
  async handler(args, ctx) {
    const { id, includeFullText } = args;
    if (!ctx.trove) {
      throw new ToolError(
        'Saving to your knowledge base needs the trove:ingest permission, which is not enabled for this connection.',
        { retryable: false },
      );
    }

    const paper = await fetchPaper(ctx, id);

    const header =
      `arXiv:${paper.id} · ${paper.categories.join(', ')} · submitted ${paper.published.slice(0, 10)}\n` +
      `Authors: ${paper.authors.join(', ')}\n\nAbstract\n${paper.summary}`;

    let includedFullText = false;
    let bodyText = '';
    if (includeFullText) {
      const html = await fetchPaperHtml(ctx, id);
      if (html) {
        const content = parseHtmlContent(html);
        bodyText = content.sections.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');
        includedFullText = bodyText.length > 0;
      }
    }

    const text = bodyText ? `${header}\n\n${bodyText}` : header;
    ctx.log('save_paper ingesting', { id: paper.id, includedFullText });

    const result = await ctx.trove.ingest([
      { title: paper.title, text, url: paper.arxivUrl, author: paper.authors.join(', ') },
    ]);

    return {
      text:
        `Saved "${paper.title}" (arXiv:${paper.id}) to your knowledge base` +
        `${includedFullText ? ' with full text' : ''}. Find it later with a Trove search.`,
      structured: {
        id: paper.id,
        title: paper.title,
        ingested: result.ingested,
        includedFullText,
      },
    };
  },
};
