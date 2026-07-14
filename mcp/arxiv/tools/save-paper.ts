import { type ToolContext, type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { arxivHtmlUrl } from '../client.ts';
import { fetchPaper, fetchPaperHtml, paperShape } from '../papers.ts';
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
    paper: paperShape
      .optional()
      .describe(
        'The paper object from a previous search_papers or get_paper call. Pass it and the ' +
          'save needs NO arXiv request at all — it is the same metadata arXiv just gave you, ' +
          'and re-fetching it is what makes a burst of saves slow enough to time out. Omit it ' +
          'only when saving an id you have not already looked up.',
      ),
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
    /**
     * What Trove will retain: the rendered HTML, falling back to the PDF when the
     * paper has none. The capture happens server-side, after this returns.
     */
    captured: z.literal('html-or-pdf'),
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

    // The metadata the caller ALREADY HAS costs nothing; fetching it again can
    // cost the whole call.
    //
    // The tool invocation is cancelled at about eight seconds. A save used to make
    // three arXiv requests — metadata, then two HEAD probes for the HTML — each
    // behind a three-second politeness throttle. When arXiv answers quickly that
    // fits; when it slows under a burst, ONE of them can spend the entire window,
    // and the caller is told "tool timed out or crashed". Measured, not guessed:
    // the worker log shows the invocation cancelled at 7.9s with the metadata
    // request still in flight.
    //
    // So a save now makes ZERO arXiv requests when the caller passes the paper it
    // just searched for, and the HTML-or-PDF decision moves server-side, where it
    // is off the hot path entirely.
    const paper = args.paper ?? (await fetchPaper(ctx, id));

    const header =
      `arXiv:${paper.id} · ${paper.categories.join(', ')} · submitted ${paper.published.slice(0, 10)}\n` +
      `Authors: ${paper.authors.join(', ')}\n\nAbstract\n${paper.summary}`;

    // Not every paper has rendered HTML, and we no longer PROBE for it: that cost
    // two more throttled arXiv requests on a call with an eight-second ceiling.
    //
    // Trove is told to capture the HTML and given the PDF as the fallback. It
    // fetches the artifact server-side, in a Workflow, where a 404 costs a retry
    // rather than the caller's entire deadline — and the PDF always exists, so the
    // paper ITSELF is retained either way, not just a description of it.
    const htmlUrl = arxivHtmlUrl(id);

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
        fileUrl: htmlUrl,
        mimeType: 'text/html',
        // If this paper has no rendered HTML, capture the PDF instead. Every arXiv
        // paper has one, so the paper ITSELF is always retained.
        //
        // A TYPED field, not a metadata bag: the first version of this passed
        // `metadata: { fallbackFileUrl }`, which the SDK's ingest document has no
        // field for — so it was dropped silently at the wire, the fallback never
        // ran, and old papers (which arXiv has not rendered) landed as bare
        // abstracts while every layer reported success.
        fallback: { fileUrl: paper.pdfUrl, mimeType: 'application/pdf' },
        ...(primaryCategory && {
          feed: { key: primaryCategory, name: primaryCategory, label: 'Category' },
        }),
      },
    ]);

    return {
      text:
        `Saved "${paper.title}" (arXiv:${paper.id}) to your knowledge base` +
        `${includedFullText ? ' with full text' : ''}. Trove is capturing the paper itself ` +
        '(the rendered HTML, or the PDF if it has none) in the background. ' +
        'Find it later with a Trove search.',
      structured: {
        id: paper.id,
        title: paper.title,
        ingested: result.ingested,
        includedFullText,
        captured: 'html-or-pdf' as const,
        capturedUrl: htmlUrl,
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
