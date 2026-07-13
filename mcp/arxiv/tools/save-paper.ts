import { type ToolContext, type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { fetchPaper, fetchPaperHtml, findPaperHtmlUrl } from '../papers.ts';
import { parseHtmlContent } from '../parse.ts';

/** `save_paper` — ingest an arXiv paper into the Trove knowledge base. */
export const savePaper: ToolDefinition = {
  name: 'save_paper',
  title: 'arXiv: Save to knowledge base',
  description:
    'Save an arXiv paper into your Trove knowledge base so you can find it later with ' +
    'a normal Trove search (no re-fetch). Stores the title, authors, abstract, arXiv id, ' +
    'categories and link, and CAPTURES the paper itself — the rendered HTML when arXiv ' +
    'has one, otherwise the PDF — so it can be read in place later. Set includeFullText ' +
    'to also index the parsed body sections, not just the abstract.',
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
    /** The artifact Trove retained: the rendered HTML, or the PDF when there is none. */
    captured: z.enum(['html', 'pdf']),
    capturedUrl: z.string(),
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

    // LOCATE the rendered HTML (a HEAD — no body). Trove downloads the artifact
    // itself, server-side, so all we owe it is a URL. Pulling the 200-300KB page
    // in here just to prove it exists is what made every save a body transfer
    // against an upstream that rate-limits datacenter IPs — and it duly started
    // timing saves out the moment it hit production.
    //
    // Not every paper has HTML (arXiv has back-rendered many, but not all, and
    // ar5iv covers more). The PDF always exists, so that is the fallback: either
    // way the paper ITSELF is retained, not just a description of it.
    const htmlUrl = await findPaperHtmlUrl(ctx, id);
    const capture = htmlUrl
      ? { url: htmlUrl, mimeType: 'text/html', kind: 'html' as const }
      : { url: paper.pdfUrl, mimeType: 'application/pdf', kind: 'pdf' as const };

    // Only NOW is the body worth downloading — the caller asked to index it.
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

    // Group saved papers by their primary arXiv category (cs.CL, math.AG, …) —
    // the paper's own subject stream, a far more useful sub-folder than its
    // multi-author byline. Omitted when the paper declares no category.
    const primaryCategory = paper.categories[0];
    const result = await ingestOrExplain(ctx, [
      {
        title: paper.title,
        text,
        url: paper.arxivUrl,
        author: paper.authors.join(', '),
        // The paper's own submission date. Without it a 2017 paper would be
        // dated by the moment it was saved, and rank as though it were new.
        date: paper.published,
        // The arXiv id — the dedup key. Saving the same paper twice resolves to
        // the document already there instead of making a second copy of it.
        externalId: paper.id,
        // Capture the paper itself. Trove downloads and retains it, and serves it
        // back in a viewer next to this text — the same deal audio gets. The text
        // above is still what gets indexed: we already parsed it, so there is no
        // reason for Trove to re-derive a worse version from the same file.
        fileUrl: capture.url,
        mimeType: capture.mimeType,
        ...(primaryCategory && {
          feed: { key: primaryCategory, name: primaryCategory, label: 'Category' },
        }),
      },
    ]);

    return {
      text:
        `Saved "${paper.title}" (arXiv:${paper.id}) to your knowledge base` +
        `${includedFullText ? ' with full text' : ''}, capturing the ${capture.kind.toUpperCase()}. ` +
        'Find it later with a Trove search.',
      structured: {
        id: paper.id,
        title: paper.title,
        ingested: result.ingested,
        includedFullText,
        captured: capture.kind,
        capturedUrl: capture.url,
      },
    };
  },
};

/**
 * Ingest, and surface the reason when it fails.
 *
 * The SDK collapses any uncaught throw into a bare "tool failed", which is what
 * an ingest error looked like from the outside — the tool broke and told nobody
 * anything, and the only way to learn more was to guess and redeploy. A save that
 * cannot happen should say why it could not happen.
 */
async function ingestOrExplain(
  ctx: ToolContext,
  docs: Parameters<NonNullable<ToolContext['trove']>['ingest']>[0],
): Promise<{ ingested: number }> {
  const trove = ctx.trove;
  if (!trove) {
    throw new ToolError('Saving to your knowledge base is not enabled for this connection.', {
      retryable: false,
    });
  }
  try {
    return await trove.ingest(docs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.log('save_paper ingest failed', { reason });
    throw new ToolError(`Trove refused the save: ${reason}`, { retryable: true });
  }
}
