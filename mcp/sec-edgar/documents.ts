import type { ToolContext } from '@ontrove/mcp';
import { decodeXmlEntities, edgarDocument, edgarJson, filingDirUrl } from './client.ts';

/**
 * Filing-document access: enumerate a filing's documents from its Archives
 * `index.json` and convert one document's SEC HTML to clean, paginated plain
 * text. Deliberately no named-section extraction (Item 1A, MD&A, …): heading
 * detection over 25 years of inconsistent filer HTML is exactly the kind of
 * fragile heuristic this server avoids — callers get clean text plus a literal
 * `find`, and read the sections themselves.
 */

export interface FilingEntry {
  name: string;
  size: number | null;
  /** Lowercased file extension, e.g. "htm", "xml", "pdf". */
  extension: string;
}

/** Extensions we can render as text. Binary formats are listed but not readable. */
const TEXT_EXTENSIONS = new Set(['htm', 'html', 'txt', 'xml']);

export const isReadable = (entry: { extension: string }): boolean =>
  TEXT_EXTENSIONS.has(entry.extension);

/**
 * EDGAR's inline-XBRL viewer plumbing — rendered R-files, linkbase sidecars,
 * schemas, styling, and generated spreadsheets. These outnumber the real
 * documents ~10:1 in a modern filing and bury the filer-authored exhibits, so
 * document listings exclude them (a specific name can still be fetched).
 */
export function isViewerArtifact(entry: FilingEntry): boolean {
  const name = entry.name.toLowerCase();
  return (
    /^r\d+\.htm$/.test(name) ||
    name === 'metalinks.json' ||
    name === 'filingsummary.xml' ||
    name === 'financial_report.xlsx' ||
    /_(cal|def|lab|pre)\.xml$/.test(name) ||
    ['xsd', 'css', 'js', 'jpg', 'jpeg', 'png', 'gif'].includes(entry.extension)
  );
}

/** List a filing's documents from its Archives directory index. */
export async function listFilingDocuments(
  ctx: ToolContext,
  cik: string,
  accession: string,
): Promise<FilingEntry[]> {
  const body = await edgarJson(
    ctx,
    `${filingDirUrl(cik, accession)}/index.json`,
    `SEC EDGAR has no filing ${accession} for CIK ${cik} (check the accession number).`,
  );
  const directory = (body.directory ?? {}) as Record<string, unknown>;
  const items = Array.isArray(directory.item) ? directory.item : [];
  const entries: FilingEntry[] = [];
  for (const raw of items) {
    const item = raw as { name?: unknown; size?: unknown };
    if (typeof item.name !== 'string') continue;
    // Skip EDGAR's own wrapper artifacts; keep the filed documents.
    if (item.name.endsWith('-index.html') || item.name.endsWith('-index-headers.html')) continue;
    const extension = item.name.includes('.') ? (item.name.split('.').pop() ?? '') : '';
    const size = Number.parseInt(String(item.size ?? ''), 10);
    entries.push({
      name: item.name,
      size: Number.isFinite(size) ? size : null,
      extension: extension.toLowerCase(),
    });
  }
  return entries;
}

/**
 * Pick the filing's primary document from its entries: the submissions-declared
 * primary when given (XSL viewer prefixes stripped), else the largest `.htm`
 * that is not an exhibit — a robust default because the primary document is
 * almost always the biggest HTML file in the directory.
 */
export function pickPrimaryDocument(
  entries: FilingEntry[],
  declaredPrimary?: string | null,
): FilingEntry | null {
  if (declaredPrimary) {
    // submissions primaryDocument may carry an XSL viewer path ("xslF345X06/form4.xml").
    const bare = declaredPrimary.split('/').pop() ?? declaredPrimary;
    const declared = entries.find((entry) => entry.name === bare);
    if (declared) return declared;
  }
  const html = entries
    .filter(
      (entry) =>
        (entry.extension === 'htm' || entry.extension === 'html') &&
        !/^ex[-_]?\d/i.test(entry.name),
    )
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  if (html[0]) return html[0];
  // Very old filings are a single .txt submission.
  return entries.find((entry) => entry.extension === 'txt') ?? null;
}

/**
 * Convert SEC filing HTML to clean plain text: drop non-content elements and
 * inline-XBRL hidden sections, keep block structure as newlines, normalize
 * entities and Windows-1252 artifacts, and collapse whitespace.
 */
export function filingHtmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Inline-XBRL hidden/header sections hold machine-readable duplicates.
    .replace(/<ix:(hidden|header)\b[^>]*>[\s\S]*?<\/ix:\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Keep coarse block structure so paragraphs and table rows stay separated.
    .replace(/<\/(p|div|tr|table|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, ' ');
  return decodeXmlEntities(text)
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface TextMatch {
  /** Character offset of the match in the full clean text (usable as `offset`). */
  offset: number;
  /** The match with surrounding context. */
  context: string;
}

/** Case-insensitive literal search returning up to `limit` matches with context. */
export function findInText(text: string, query: string, limit = 10): TextMatch[] {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: TextMatch[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1 && matches.length < limit) {
    const start = Math.max(0, at - 240);
    const end = Math.min(text.length, at + needle.length + 240);
    matches.push({
      offset: at,
      context: `${start > 0 ? '…' : ''}${text.slice(start, end).replaceAll('\n', ' ').trim()}${end < text.length ? '…' : ''}`,
    });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return matches;
}

/** Fetch one filing document and return its clean text. */
export async function fetchFilingText(
  ctx: ToolContext,
  cik: string,
  accession: string,
  entry: FilingEntry,
): Promise<string> {
  const body = await edgarDocument(
    ctx,
    `${filingDirUrl(cik, accession)}/${entry.name}`,
    `Document "${entry.name}" was not found in filing ${accession}.`,
  );
  if (entry.extension === 'txt') {
    // Old full-text submissions: strip SGML/HTML tags and page markers.
    return filingHtmlToText(body.replace(/<PAGE>/g, '\n'));
  }
  return filingHtmlToText(body);
}
