import { type ToolContext, ToolError, z } from '@ontrove/mcp';
import { ARXIV_API, ar5ivHtmlUrl, arxivFetch, arxivHtmlUrl } from './client.ts';
import { type ArxivPaper, parseFeed } from './parse.ts';

/**
 * Shared paper primitives across the arxiv tools: the metadata output shape,
 * small human-readable summary helpers, and the network fetchers for a single
 * paper's Atom metadata and its LaTeXML full-text HTML.
 */

/** Fetch a paper's LaTeXML HTML, trying arXiv's native view then ar5iv. */
export async function fetchPaperHtml(ctx: ToolContext, id: string): Promise<string | null> {
  for (const url of [arxivHtmlUrl(id), ar5ivHtmlUrl(id)]) {
    const { status, body } = await arxivFetch(ctx, url, { accept: 'text/html' });
    // A real LaTeXML page contains `ltx_` classes; a stub/redirect won't.
    if (status === 200 && body.includes('ltx_')) return body;
  }
  return null;
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
