/**
 * OEIS — a no-auth hosted MCP server over the On-Line Encyclopedia of Integer
 * Sequences (oeis.org). Two read-only surfaces:
 *  - `search_sequences` — find sequences by leading terms or by name, and
 *  - `get_sequence`     — read one sequence's definition, formulas, and comments.
 * OEIS content is licensed CC BY-SA 4.0; no key required. The search endpoint
 * returns a bare JSON array of sequence records.
 */
import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

const BASE_URL = 'https://oeis.org';

/** GET an OEIS URL and parse JSON (search returns a top-level array). */
async function getJson(url: string, ctx: ToolContext): Promise<unknown> {
  return ctx.fetchJson(url, {
    init: { headers: { accept: 'application/json' } },
    errorMap: (res, body) =>
      new ToolError(`OEIS returned ${res.status}: ${body.slice(0, 100)}`, {
        retryable: res.status === 429 || res.status >= 500,
      }),
  });
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const joinLines = (value: unknown): string =>
  Array.isArray(value) ? value.filter((s) => typeof s === 'string').join('\n') : '';

/** OEIS A-number from the raw integer id (45 → "A000045"). */
function aNumber(value: unknown): string {
  return typeof value === 'number' ? `A${String(value).padStart(6, '0')}` : '';
}

/** Normalise a user-supplied id ("45", "a45", "A000045") to canonical "A000045". */
function normalizeId(id: string): string {
  const digits = id.replace(/^a/i, '');
  return /^\d+$/.test(digits) ? `A${digits.padStart(6, '0')}` : id.toUpperCase();
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_sequences',
      title: 'OEIS: Search integer sequences',
      description:
        'Search the OEIS by leading terms (e.g. "1, 1, 2, 3, 5, 8" to identify a ' +
        'sequence) or by descriptive words (e.g. "Catalan numbers"). Returns each match ' +
        'with its A-number, name, and leading terms.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Leading terms or descriptive words.'),
        limit: z.number().int().min(1).max(12).default(10).describe('Max results (1–12).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        sequences: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            terms: z.string(),
            keywords: z.string(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('search_sequences', { query, limit });
        const data = await getJson(
          `${BASE_URL}/search?${new URLSearchParams({ q: query, fmt: 'json' })}`,
          ctx,
        );
        const results = Array.isArray(data) ? data : [];
        const sequences = results.slice(0, limit).map((raw) => {
          const record = (raw ?? {}) as Record<string, unknown>;
          return {
            id: aNumber(record.number),
            name: str(record.name),
            terms: str(record.data),
            keywords: str(record.keyword),
          };
        });
        if (sequences.length === 0) {
          return {
            text: `No OEIS sequences matched "${query}".`,
            structured: { query, count: 0, sequences: [] },
          };
        }
        const lines = sequences
          .map((s) => `  ${s.id}  ${s.name}\n    ${s.terms.slice(0, 70)}…`)
          .join('\n');
        return {
          text: `${sequences.length} sequence(s) for "${query}":\n${lines}`,
          structured: { query, count: sequences.length, sequences },
        };
      },
    },
    {
      name: 'get_sequence',
      title: 'OEIS: Get a sequence',
      description:
        'Fetch one OEIS sequence by its A-number (e.g. "A000045", Fibonacci). Returns its ' +
        'name, terms, formulas, comments, worked examples, keywords, and author.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z.string().min(1).describe('OEIS A-number, e.g. "A000045".'),
      }),
      output: z.object({
        id: z.string(),
        name: z.string(),
        terms: z.string(),
        formula: z.string(),
        comments: z.string(),
        example: z.string(),
        keywords: z.string(),
        author: z.string(),
        url: z.string(),
      }),
      async handler(args, ctx) {
        const id = normalizeId(args.id);
        ctx.log('get_sequence', { id });
        const data = await getJson(
          `${BASE_URL}/search?${new URLSearchParams({ q: `id:${id}`, fmt: 'json' })}`,
          ctx,
        );
        const results = Array.isArray(data) ? data : [];
        const record = results[0] as Record<string, unknown> | undefined;
        if (!record) {
          throw new ToolError(`No OEIS sequence ${id}.`, { retryable: false });
        }
        const canonical = aNumber(record.number) || id;
        const sequence = {
          id: canonical,
          name: str(record.name),
          terms: str(record.data),
          formula: joinLines(record.formula),
          comments: joinLines(record.comment),
          example: joinLines(record.example),
          keywords: str(record.keyword),
          author: str(record.author),
          url: `${BASE_URL}/${canonical}`,
        };
        const text = `${sequence.id} — ${sequence.name}\n  ${sequence.terms}${sequence.formula ? `\n\nFormula:\n${sequence.formula}` : ''}`;
        return { text, structured: sequence };
      },
    },
  ],
});
