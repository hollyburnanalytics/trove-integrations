import { type ToolDefinition, z } from '@ontrove/mcp';
import { collectWcatDecisions, wcatLine } from '../wcat.ts';

/**
 * `get_wcat_decision` — look up a single WCAT decision by its exact number.
 */
export const getWcatDecision: ToolDefinition = {
  name: 'get_wcat_decision',
  title: 'WCAT: Look up a decision by number',
  description:
    'Look up a single WCAT decision by its exact appeal/decision number ' +
    '(e.g. "A2002996" or "2012-00718"). Returns its date, types, issue summary, and a ' +
    'link to the official PDF, or reports that no decision has that number.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    number: z.string().min(1).describe('Exact WCAT appeal/decision number, e.g. "A2002996".'),
  }),
  output: z.object({
    found: z.boolean(),
    decision: z
      .object({
        number: z.string(),
        date: z.string().nullable(),
        applicationType: z.string().nullable(),
        documentType: z.string().nullable(),
        issues: z.string().nullable(),
        pdfUrl: z.string(),
      })
      .nullable(),
  }),
  async handler(args, ctx) {
    const number = args.number.trim();
    ctx.log('get_wcat_decision', { number });
    const params = new URLSearchParams({ q: '', appeal_number: number, sortby: 'date' });
    const decisions = await collectWcatDecisions(params, 10, ctx);
    const match =
      decisions.find((d) => d.number.toLowerCase() === number.toLowerCase()) ?? decisions[0];
    if (!match) {
      return {
        text: `No WCAT decision found for "${number}".`,
        structured: { found: false, decision: null },
      };
    }
    return {
      text: `WCAT Decision ${match.number}:\n${wcatLine(match)}`,
      structured: { found: true, decision: match },
    };
  },
};
