import { type ToolContext, ToolError, z } from '@ontrove/mcp';
import { ARXIV_API, ar5ivHtmlUrl, arxivFetch, arxivHtmlUrl } from './client.ts';
import { type ArxivPaper, parseFeed } from './parse.ts';

/**
 * Shared paper primitives across the arxiv tools: the metadata output shape,
 * small human-readable summary helpers, and the network fetchers for a single
 * paper's Atom metadata and its LaTeXML full-text HTML.
 */

/** A paper's LaTeXML HTML, and the URL it actually came from. */
export interface PaperHtml {
  /** The URL that served it — arXiv's native view, or ar5iv's rendering. */
  url: string;
  html: string;
}

/**
 * Find the URL of a paper's rendered HTML — WITHOUT downloading it.
 *
 * `save_paper` needs the URL, not the bytes: Trove fetches the artifact itself,
 * server-side. Downloading a 200–300KB page here just to learn it exists put a
 * body transfer on the hot path of every save, against an upstream that
 * rate-limits and tarpits datacenter IPs, and duly started timing saves out.
 *
 * A HEAD answers the only question we have — but ONLY if it is not allowed to
 * follow a redirect:
 *
 *     HEAD arxiv.org/html/{id}   200 → rendered      404 → not rendered
 *     HEAD ar5iv/html/{id}       200 → rendered      307 → arxiv.org/abs/{id}
 *
 * ar5iv answers **307 to the abstract page** for every paper it has not
 * rendered. A redirect-following probe takes the 200 at the end of that hop and
 * reports "HTML found" — and we then captured arXiv's ABSTRACT LANDING PAGE and
 * indexed "Submission history" and "Bibliographic and Citation Tools" as if they
 * were the physics. A redirect IS the "no HTML" answer; it must not be followed.
 *
 * @returns The HTML URL, or null when neither renderer has one — the caller's
 *   cue to capture the PDF instead, which always exists.
 */
export async function findPaperHtmlUrl(ctx: ToolContext, id: string): Promise<string | null> {
  for (const url of [arxivHtmlUrl(id), ar5ivHtmlUrl(id)]) {
    try {
      const res = await ctx.fetch(url, { method: 'HEAD' });
      if (!res.ok) continue;
      // The redirect is the point. `redirect: 'manual'` would be the direct way
      // to see it, but that init does not survive the hosted egress path — it
      // fails the whole call. The response says the same thing on its own terms:
      // a followed redirect leaves `redirected` set, and the final URL is no
      // longer the /html/ one we asked for. Either is a "no".
      if (res.redirected) continue;
      if (!new URL(res.url || url).pathname.includes('/html/')) continue;
      return url;
    } catch {
      // A probe is best-effort: a failure here must fall through to the PDF,
      // never sink the save.
    }
  }
  return null;
}

/**
 * Fetch a paper's LaTeXML HTML, trying arXiv's native view then ar5iv, and
 * report WHICH URL served it. Downloads the body — only call it when the body is
 * actually wanted (`includeFullText`). To merely locate the HTML, use
 * {@link findPaperHtmlUrl}.
 */
export async function resolvePaperHtml(ctx: ToolContext, id: string): Promise<PaperHtml | null> {
  for (const url of [arxivHtmlUrl(id), ar5ivHtmlUrl(id)]) {
    const { status, body } = await arxivFetch(ctx, url, { accept: 'text/html' });
    // A real LaTeXML page contains `ltx_` classes; a stub/redirect won't.
    if (status === 200 && body.includes('ltx_')) return { url, html: body };
  }
  return null;
}

/** Fetch a paper's LaTeXML HTML body. See {@link resolvePaperHtml} for the URL too. */
export async function fetchPaperHtml(ctx: ToolContext, id: string): Promise<string | null> {
  return (await resolvePaperHtml(ctx, id))?.html ?? null;
}

// ---------------------------------------------------------------------------
// Shapes + summaries
// ---------------------------------------------------------------------------

export const paperShape = z.object({
  id: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  summary: z.string(),
  published: z.string(),
  updated: z.string(),
  categories: z.array(z.string()),
  pdfUrl: z.string(),
  arxivUrl: z.string(),
});

/** Truncate long text for the human-readable summary. */
export function truncate(value: string, max = 280): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** A one-line author display ("A, B, C et al."). */
export function authorLine(authors: string[]): string {
  return authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '');
}

/** Fetch a single paper's metadata by id (shared by get_paper and save_paper). */
export async function fetchPaper(ctx: ToolContext, id: string): Promise<ArxivPaper> {
  const { status, body } = await arxivFetch(ctx, `${ARXIV_API}?id_list=${encodeURIComponent(id)}`, {
    accept: 'application/atom+xml',
  });
  if (status === 400) throw new ToolError(`arXiv rejected the id "${id}".`, { retryable: false });
  const paper = parseFeed(body)[0];
  if (!paper) throw new ToolError(`No arXiv paper found with id "${id}".`, { retryable: false });
  return paper;
}
