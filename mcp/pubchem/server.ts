/**
 * PubChem — a no-auth hosted MCP server over PubChem's PUG REST API
 * (pubchem.ncbi.nlm.nih.gov), the NIH/NLM chemical database. Two read-only surfaces:
 *  - `get_compound`     — resolve a compound name to its identity and properties, and
 *  - `search_compounds` — autocomplete compound names.
 * Most PubChem records are free to use; depositor-contributed data may carry its
 * own terms. No key required.
 */
import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { getJson } from '../lib/http.ts';

const BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest';
const PROPS = 'MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChIKey,XLogP,TPSA';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
function num(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)))
    return Number(value);
  return null;
}

/** Best-effort plain-language description for a CID (optional; failures ignored). */
async function fetchDescription(cid: number, ctx: ToolContext): Promise<string | null> {
  try {
    const body = await getJson(`${BASE_URL}/pug/compound/cid/${cid}/description/JSON`, ctx, {
      service: 'PubChem',
      notFound: 'No PubChem record matched.',
    });
    const info = ((body.InformationList ?? {}) as { Information?: unknown }).Information;
    for (const entry of Array.isArray(info) ? info : []) {
      const description = str((entry as { Description?: unknown }).Description);
      if (description) return description;
    }
  } catch {
    // description is a nice-to-have
  }
  return null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'get_compound',
      title: 'PubChem: Get a compound',
      description:
        'Resolve a chemical name (e.g. "aspirin", "caffeine") to its PubChem CID and key ' +
        'properties: molecular formula, weight, IUPAC name, SMILES, InChIKey, XLogP, and ' +
        'polar surface area, plus a plain-language description when available.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({ name: z.string().min(1).describe('Compound name, e.g. "ibuprofen".') }),
      output: z.object({
        name: z.string(),
        cid: z.number(),
        formula: z.string().nullable(),
        weight: z.number().nullable(),
        iupacName: z.string().nullable(),
        smiles: z.string().nullable(),
        inchiKey: z.string().nullable(),
        xlogp: z.number().nullable(),
        tpsa: z.number().nullable(),
        description: z.string().nullable(),
        url: z.string(),
      }),
      async handler(args, ctx) {
        const { name } = args;
        ctx.log('get_compound', { name });
        const body = await getJson(
          `${BASE_URL}/pug/compound/name/${encodeURIComponent(name)}/property/${PROPS}/JSON`,
          ctx,
          { service: 'PubChem', notFound: 'No PubChem record matched.' },
        );
        const properties = ((body.PropertyTable ?? {}) as { Properties?: unknown }).Properties;
        const record = (Array.isArray(properties) ? properties[0] : undefined) as
          | Record<string, unknown>
          | undefined;
        if (!record || typeof record.CID !== 'number') {
          throw new ToolError(`No PubChem compound named "${name}".`, { retryable: false });
        }
        const cid = record.CID;
        const compound = {
          name,
          cid,
          formula: str(record.MolecularFormula) || null,
          weight: num(record.MolecularWeight),
          iupacName: str(record.IUPACName) || null,
          smiles: str(record.ConnectivitySMILES) || str(record.CanonicalSMILES) || null,
          inchiKey: str(record.InChIKey) || null,
          xlogp: num(record.XLogP),
          tpsa: num(record.TPSA),
          description: await fetchDescription(cid, ctx),
          url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
        };
        const text =
          `${name} (CID ${cid})\n` +
          `  Formula: ${compound.formula ?? '?'} · MW: ${compound.weight ?? '?'}\n` +
          `  IUPAC: ${compound.iupacName ?? '?'}` +
          `${compound.description ? `\n  ${compound.description}` : ''}`;
        return { text, structured: compound };
      },
    },
    {
      name: 'search_compounds',
      title: 'PubChem: Autocomplete compound names',
      description:
        'Find compound names matching a partial query (autocomplete) — use when you are ' +
        'unsure of the exact name to pass to get_compound.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Partial compound name, e.g. "aspir".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max suggestions (1–25).'),
      }),
      output: z.object({ query: z.string(), count: z.number(), names: z.array(z.string()) }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('search_compounds', { query, limit });
        const body = await getJson(
          `${BASE_URL}/autocomplete/compound/${encodeURIComponent(query)}/JSON?limit=${limit}`,
          ctx,
          { service: 'PubChem', notFound: 'No PubChem record matched.' },
        );
        const terms = ((body.dictionary_terms ?? {}) as { compound?: unknown }).compound;
        const names = (Array.isArray(terms) ? terms : [])
          .filter((s): s is string => typeof s === 'string')
          .slice(0, limit);
        if (names.length === 0) {
          return {
            text: `No compound names matched "${query}".`,
            structured: { query, count: 0, names: [] },
          };
        }
        return {
          text: `${names.length} suggestion(s) for "${query}":\n${names.map((n) => `  ${n}`).join('\n')}`,
          structured: { query, count: names.length, names },
        };
      },
    },
  ],
});
