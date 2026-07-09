import { type ToolDefinition, z } from '@ontrove/mcp';
import { fetchPaper, paperShape } from '../papers.ts';

/** `get_paper` — fetch a single arXiv paper's metadata by identifier. */
export const getPaper: ToolDefinition = {
  name: 'get_paper',
  title: 'arXiv: Get paper',
  description:
    'Fetch a single arXiv paper by its identifier (e.g. "2510.25417" or ' +
    '"2510.25417v1"). Returns the title, authors, full abstract, dates, ' +
    'categories and links. For the full body text, use get_paper_content.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    id: z
      .string()
      .min(1)
      .describe('arXiv paper id, e.g. "2510.25417" (an optional version suffix is allowed).'),
  }),
  output: paperShape,
  async handler(args, ctx) {
    ctx.log('get_paper querying arXiv', { id: args.id });
    const paper = await fetchPaper(ctx, args.id);
    return {
      text:
        `${paper.id} — ${paper.title}\n${paper.authors.join(', ')}\n` +
        `Published ${paper.published.slice(0, 10)} · Updated ${paper.updated.slice(0, 10)} · ` +
        `${paper.categories.join(', ')}\nPDF: ${paper.pdfUrl}\n\n${paper.summary}`,
      structured: paper,
    };
  },
};
