import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import { WCAT_APPLICATION_TYPES, WCAT_CLASSIFICATIONS, WCAT_DOCUMENT_TYPES } from '../shapes.ts';
import { collectWcatDecisions, wcatLine } from '../wcat.ts';

/**
 * `search_wcat_decisions` — keyword/facet search over WCAT's published decisions.
 */
export const searchWcatDecisions: ToolDefinition = {
  name: 'search_wcat_decisions',
  title: 'WCAT: Search decisions',
  description:
    "Search the BC Workers' Compensation Appeal Tribunal's published decisions. " +
    'Pass a keyword/phrase in `query` (operators: `+` AND, `|` OR, `-` exclude, ' +
    '`"..."` phrase, `*` wildcard) and/or narrow with a facet: `classification` ' +
    '(noteworthy/precedent), `applicationType`, `documentType`, or a `startDate`/' +
    '`endDate` range. With a facet set, `query` may be omitted to browse all matching ' +
    'decisions. Newest first. Returns decision number, date, types, the "issues under ' +
    'appeal" summary, and a link to the official PDF.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Keyword or phrase, e.g. \'"wrist fracture"\'. Optional if a facet is set.'),
    classification: z.enum(WCAT_CLASSIFICATIONS).optional().describe('Filter by classification.'),
    applicationType: z.enum(WCAT_APPLICATION_TYPES).optional().describe('Appeal/application type.'),
    documentType: z.enum(WCAT_DOCUMENT_TYPES).optional().describe('Decision/document type.'),
    startDate: z.string().optional().describe('Earliest decision date, YYYY-MM-DD.'),
    endDate: z.string().optional().describe('Latest decision date, YYYY-MM-DD.'),
    limit: z.number().int().min(1).max(50).default(20).describe('Max decisions to return.'),
  }),
  output: z.object({
    count: z.number(),
    decisions: z.array(
      z.object({
        number: z.string(),
        date: z.string().nullable(),
        applicationType: z.string().nullable(),
        documentType: z.string().nullable(),
        issues: z.string().nullable(),
        pdfUrl: z.string(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { query, classification, applicationType, documentType, startDate, endDate, limit } =
      args;
    const hasFacet = Boolean(
      classification || applicationType || documentType || startDate || endDate,
    );
    if (!query && !hasFacet) {
      throw new ToolError('Provide a `query` or at least one facet to search WCAT.');
    }
    ctx.log('search_wcat_decisions', { query, classification, applicationType, limit });

    const params = new URLSearchParams({ q: query ?? '', sortby: 'date' });
    if (classification) params.set('classification', classification);
    if (applicationType) params.set('application_type', applicationType);
    if (documentType) params.set('document_type', documentType);
    if (startDate) params.set('start_date', startDate);
    if (endDate) params.set('end_date', endDate);

    const decisions = await collectWcatDecisions(params, limit, ctx);
    if (decisions.length === 0) {
      return { text: 'No WCAT decisions matched.', structured: { count: 0, decisions: [] } };
    }
    return {
      text: `${decisions.length} WCAT decision(s):\n${decisions.map(wcatLine).join('\n')}`,
      structured: { count: decisions.length, decisions },
    };
  },
};
