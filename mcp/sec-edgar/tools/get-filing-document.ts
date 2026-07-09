import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { normalizeAccession, requireCompany } from '../client.ts';
import {
  type FilingEntry,
  fetchFilingText,
  findInText,
  isReadable,
  isViewerArtifact,
  listFilingDocuments,
  pickPrimaryDocument,
} from '../documents.ts';
import { recentFilings } from '../submissions.ts';

/**
 * `get_filing_document` — read one filing document as clean, paginated,
 * searchable plain text (see `documents.ts` for the HTML→text rules).
 */

export const getFilingDocument: ToolDefinition = {
  name: 'get_filing_document',
  title: 'EDGAR: Read a filing',
  description:
    'Read the text of an SEC filing (10-K, 10-Q, 8-K, proxy, S-1, …) given its ' +
    'accession number — from search_filings or company_filings. Returns clean plain ' +
    'text with character-offset pagination (follow nextOffset for more), the list of ' +
    'documents/exhibits in the filing (pass `document` to read a specific one), and ' +
    'an optional literal `find` that returns each match with surrounding context and ' +
    'its offset, so you can jump straight to a passage (e.g. find "risk factors" or ' +
    '"climate"). For financial NUMBERS prefer get_financials/get_xbrl_concept.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z.string().min(1).describe('Ticker, company name, or CIK of the filer.'),
    accession: z
      .string()
      .regex(/^\d{10}-?\d{2}-?\d{6}$/)
      .describe('Accession number, e.g. "0000320193-25-000079".'),
    document: z
      .string()
      .optional()
      .describe('A specific document/exhibit filename from the documents list.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Character offset to start from; pass the returned nextOffset.'),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(100_000)
      .default(20_000)
      .describe('Max characters of text to return (default 20000).'),
    find: z
      .string()
      .optional()
      .describe('Literal text to locate (case-insensitive); returns matches + offsets.'),
  }),
  output: z.object({
    company: z.string(),
    cik: z.string(),
    accession: z.string(),
    document: z.string(),
    documents: z.array(
      z.object({ name: z.string(), size: z.number().nullable(), extension: z.string() }),
    ),
    totalChars: z.number(),
    offset: z.number(),
    nextOffset: z.number().nullable(),
    content: z.string(),
    matches: z.array(z.object({ offset: z.number(), context: z.string() })),
  }),
  async handler(args, ctx) {
    const { company, document, offset, maxChars, find } = args;
    const accession = normalizeAccession(args.accession);
    ctx.log('get_filing_document', { company, accession, document, find });
    const resolved = await requireCompany(ctx, company);
    const entries = await listFilingDocuments(ctx, resolved.cik, accession);
    // Hide EDGAR's XBRL-viewer plumbing (R-files, linkbase sidecars, CSS/JS)
    // from the listing; an explicitly named document is still fetchable.
    const substantive = entries.filter((e) => !isViewerArtifact(e));

    let entry: FilingEntry | null;
    if (document) {
      entry = entries.find((e) => e.name === document) ?? null;
      if (!entry) {
        const names = substantive.map((e) => e.name).join(', ');
        throw new ToolError(`No document "${document}" in ${accession}. Available: ${names}`, {
          retryable: false,
        });
      }
    } else {
      const { filings } = await recentFilings(ctx, resolved.cik);
      const declared = filings.find((f) => f.accession === accession)?.primaryDocument;
      entry = pickPrimaryDocument(substantive, declared);
    }
    if (!entry) {
      throw new ToolError(`Filing ${accession} has no readable primary document.`, {
        retryable: false,
      });
    }
    if (!isReadable(entry)) {
      throw new ToolError(
        `"${entry.name}" is a ${entry.extension.toUpperCase()} file, which cannot be ` +
          'rendered as text here. Pick an .htm/.txt/.xml document from the documents list.',
        { retryable: false },
      );
    }

    const text = await fetchFilingText(ctx, resolved.cik, accession, entry);
    const matches = find ? findInText(text, find) : [];
    const content = text.slice(offset, offset + maxChars);
    const nextOffset = offset + content.length < text.length ? offset + content.length : null;
    const documents = substantive.map(({ name, size, extension }) => ({
      name,
      size,
      extension,
    }));

    const matchText =
      find === undefined
        ? ''
        : matches.length > 0
          ? `\n${matches.length} match(es) for "${find}":\n${matches
              .map((m) => `  [offset ${m.offset}] ${m.context}`)
              .join('\n')}\n`
          : `\nNo matches for "${find}".\n`;
    const moreText = nextOffset === null ? '' : `\n(more — call again with offset=${nextOffset})`;
    return {
      text:
        `${entry.name} in ${accession} (${resolved.name || company}) — ` +
        `${text.length.toLocaleString('en-US')} chars total, showing ${offset}–${offset + content.length}:` +
        `${matchText}\n${content}${moreText}`,
      structured: {
        company: resolved.name || company,
        cik: resolved.cik,
        accession,
        document: entry.name,
        documents,
        totalChars: text.length,
        offset,
        nextOffset,
        content,
        matches,
      },
    };
  },
};
