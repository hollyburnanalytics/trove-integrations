import { type ToolContext, ToolError, tool, z } from '@ontrove/mcp';
import { ar5ivHtmlUrl } from '../client.ts';
import { fetchPaper, paperShape } from '../papers.ts';

/** `save_paper` — ingest an arXiv paper into the Trove knowledge base. */
export const savePaper = tool({
  name: 'save_paper',
  title: 'arXiv: Save to knowledge base',
  description:
    'Save an arXiv paper into your Trove knowledge base so you can find it later with ' +
    'a normal Trove search (no re-fetch). Stores the title, authors, abstract, arXiv id, ' +
    'categories and link, and CAPTURES the paper from ar5iv (whose HTML carries each ' +
    "formula's LaTeX source) so its full text — with clean math — is read in place later. " +
    'A paper ar5iv has not rendered is saved abstract-only.',
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
  }),
  output: z.object({
    id: z.string(),
    title: z.string(),
    ingested: z.number(),
    /** ar5iv's rendered HTML, captured server-side after this returns. */
    captured: z.literal('ar5iv-html'),
    capturedUrl: z.string(),
  }),
  async handler(args, ctx) {
    const { id } = args;
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

    // ar5iv is the single full-text source. Its HTML carries each formula's LaTeX
    // as an `alttext`/annotation, which the server-side capture (to-text.ts) turns
    // into clean `$…$` math — where arXiv's own /html/ renders bare glyphs. Trove
    // captures it in a Workflow, off this tool's eight-second hot path. No PDF
    // fallback by design: a paper ar5iv cannot render is saved abstract-only — one
    // predictable path, not a silent degrade to a worse parser.
    const htmlUrl = ar5ivHtmlUrl(id);

    // This tool no longer parses the body itself: the capture is the single reducer.
    // We index the header; the full text arrives when the capture completes.
    const text = header;
    ctx.log('save_paper ingesting', { id: paper.id });

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
        // Capture the paper from ar5iv. Trove downloads and retains it, serves it
        // back in a viewer, AND derives the indexed full text from it — the capture
        // is the single reducer, so the header above is all this tool indexes.
        fileUrl: htmlUrl,
        mimeType: 'text/html',
        ...(primaryCategory && {
          feed: { key: primaryCategory, name: primaryCategory, label: 'Category' },
        }),
      },
    ]);

    return {
      text:
        `Saved "${paper.title}" (arXiv:${paper.id}) to your knowledge base. Trove is ` +
        'capturing the paper from ar5iv in the background and will index its full text ' +
        '(with clean math). Find it later with a Trove search.',
      structured: {
        id: paper.id,
        title: paper.title,
        ingested: result.ingested,
        captured: 'ar5iv-html' as const,
        capturedUrl: htmlUrl,
      },
    };
  },
});

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
