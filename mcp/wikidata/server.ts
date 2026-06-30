/**
 * Wikidata — a no-auth hosted MCP server over Wikidata (www.wikidata.org), the
 * CC0 structured knowledge graph behind Wikipedia. Two read-only surfaces:
 *  - `search_entities` — find items (Q-ids) by name, and
 *  - `get_entity`      — an item's label, description, aliases, and statements,
 *    with property names and entity-valued targets resolved to readable labels.
 * A descriptive User-Agent is sent per Wikimedia's User-Agent policy.
 */
import type { ToolContext } from '@ontrove/mcp';
import { defineMcpServer, ToolError, z } from '@ontrove/mcp';
import { getJson } from '../lib/http.ts';

const BASE_URL = 'https://www.wikidata.org';
const USER_AGENT = 'TroveBot/1.0 (https://github.com/hollyburnanalytics/trove-integrations)';
const MAX_PROPERTIES = 30;
const MAX_VALUES = 5;
const RESOLVE_CHUNK = 50; // wbgetentities accepts up to 50 ids per call

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Format a Wikidata time value (e.g. {time:"+0121-04-26T..", precision:11}). */
function formatTime(value: Record<string, unknown>): string {
  const match = str(value.time).match(/^([+-])(\d+)-(\d\d)-(\d\d)/);
  if (!match) return str(value.time);
  const era = match[1] === '-' ? ' BCE' : '';
  const year = String(Number(match[2]));
  const precision = typeof value.precision === 'number' ? value.precision : 11;
  if (precision <= 9) return `${year}${era}`;
  if (precision === 10) return `${year}-${match[3]}${era}`;
  return `${year}-${match[3]}-${match[4]}${era}`;
}

/**
 * Reduce a statement's mainsnak to a printable value. Entity references return
 * their Q/P-id in `ref` (resolved to a label later); other datatypes are
 * formatted inline.
 */
function snakValue(snak: Record<string, unknown>): { text: string; ref?: string } {
  if (snak.snaktype !== 'value') {
    return { text: snak.snaktype === 'novalue' ? 'none' : 'unknown' };
  }
  const data = (snak.datavalue ?? {}) as { type?: unknown; value?: unknown };
  const value = data.value;
  switch (data.type) {
    case 'wikibase-entityid': {
      const id = str((value as { id?: unknown }).id);
      return { text: id, ref: id };
    }
    case 'time':
      return { text: formatTime((value ?? {}) as Record<string, unknown>) };
    case 'quantity':
      return { text: str((value as { amount?: unknown }).amount).replace(/^\+/, '') };
    case 'monolingualtext':
      return { text: str((value as { text?: unknown }).text) };
    case 'globecoordinate': {
      const coordinate = (value ?? {}) as { latitude?: unknown; longitude?: unknown };
      return {
        text:
          typeof coordinate.latitude === 'number'
            ? `${coordinate.latitude}, ${coordinate.longitude}`
            : '',
      };
    }
    default:
      return { text: typeof value === 'string' ? value : '' };
  }
}

/** Collect up to MAX_PROPERTIES properties, each with up to MAX_VALUES values. */
function collectStatements(
  claims: Record<string, unknown>,
): { property: string; values: { text: string; ref?: string }[] }[] {
  const statements: { property: string; values: { text: string; ref?: string }[] }[] = [];
  for (const [property, raw] of Object.entries(claims).slice(0, MAX_PROPERTIES)) {
    const list = Array.isArray(raw) ? raw : [];
    const values = list
      .slice(0, MAX_VALUES)
      .map((statement) => {
        const mainsnak = ((statement ?? {}) as { mainsnak?: unknown }).mainsnak;
        return snakValue((mainsnak ?? {}) as Record<string, unknown>);
      })
      .filter((value) => value.text);
    if (values.length > 0) statements.push({ property, values });
  }
  return statements;
}

/** Batch-resolve Q/P-ids to English labels (chunked to the API's per-call cap). */
async function resolveLabels(ids: string[], ctx: ToolContext): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (let index = 0; index < ids.length; index += RESOLVE_CHUNK) {
    const chunk = ids.slice(index, index + RESOLVE_CHUNK);
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: chunk.join('|'),
      props: 'labels',
      languages: 'en',
      format: 'json',
    });
    const body = await getJson(`${BASE_URL}/w/api.php?${params}`, ctx, {
      service: 'Wikidata',
      headers: { 'user-agent': USER_AGENT },
    });
    const entities = (body.entities ?? {}) as Record<string, unknown>;
    for (const [id, entity] of Object.entries(entities)) {
      const label = ((entity ?? {}) as { labels?: { en?: { value?: unknown } } }).labels?.en?.value;
      if (typeof label === 'string') labels.set(id, label);
    }
  }
  return labels;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_entities',
      title: 'Wikidata: Search entities',
      description:
        'Search Wikidata for items by name. Returns each match with its Q-id, label, and ' +
        'description — pass the Q-id to get_entity for structured facts.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Entity name, e.g. "Marcus Aurelius".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        entities: z.array(
          z.object({ id: z.string(), label: z.string(), description: z.string().nullable() }),
        ),
      }),
      async handler(args, ctx) {
        const { query, limit } = args;
        ctx.log('search_entities', { query, limit });
        const params = new URLSearchParams({
          action: 'wbsearchentities',
          search: query,
          language: 'en',
          uselang: 'en',
          format: 'json',
          limit: String(limit),
        });
        const body = await getJson(`${BASE_URL}/w/api.php?${params}`, ctx, {
          service: 'Wikidata',
          headers: { 'user-agent': USER_AGENT },
        });
        const results = Array.isArray(body.search) ? body.search : [];
        const entities = results.map((raw) => {
          const record = (raw ?? {}) as Record<string, unknown>;
          return {
            id: str(record.id),
            label: str(record.label),
            description: str(record.description) || null,
          };
        });
        if (entities.length === 0) {
          return {
            text: `No Wikidata entities matched "${query}".`,
            structured: { query, count: 0, entities: [] },
          };
        }
        const lines = entities
          .map((e) => `  [${e.id}] ${e.label}${e.description ? ` — ${e.description}` : ''}`)
          .join('\n');
        return {
          text: `${entities.length} entity(ies) for "${query}":\n${lines}`,
          structured: { query, count: entities.length, entities },
        };
      },
    },
    {
      name: 'get_entity',
      title: 'Wikidata: Get entity facts',
      description:
        'Fetch a Wikidata item by Q-id (e.g. "Q1430") and return its label, description, ' +
        'aliases, and statements as readable "property: value" facts — property names and ' +
        'entity-valued targets (people, places, occupations) resolved to labels. CC0 data.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        id: z
          .string()
          .regex(/^[Qq]\d+$/)
          .describe('Wikidata item id, e.g. "Q1430".'),
      }),
      output: z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        aliases: z.array(z.string()),
        url: z.string(),
        facts: z.array(z.object({ property: z.string(), values: z.array(z.string()) })),
      }),
      async handler(args, ctx) {
        const id = args.id.toUpperCase();
        ctx.log('get_entity', { id });
        const params = new URLSearchParams({
          action: 'wbgetentities',
          ids: id,
          props: 'labels|descriptions|aliases|claims',
          languages: 'en',
          format: 'json',
        });
        const body = await getJson(`${BASE_URL}/w/api.php?${params}`, ctx, {
          service: 'Wikidata',
          headers: { 'user-agent': USER_AGENT },
        });
        const entity = ((body.entities ?? {}) as Record<string, unknown>)[id] as
          | Record<string, unknown>
          | undefined;
        if (!entity || entity.missing !== undefined) {
          throw new ToolError(`No Wikidata entity ${id}.`, { retryable: false });
        }
        const label = ((entity.labels ?? {}) as { en?: { value?: unknown } }).en?.value;
        const description = ((entity.descriptions ?? {}) as { en?: { value?: unknown } }).en?.value;
        const aliasList = ((entity.aliases ?? {}) as { en?: unknown }).en;
        const aliases = (Array.isArray(aliasList) ? aliasList : [])
          .map((alias) => str((alias as { value?: unknown }).value))
          .filter(Boolean)
          .slice(0, 8);

        const statements = collectStatements((entity.claims ?? {}) as Record<string, unknown>);
        const references = new Set<string>();
        for (const statement of statements) {
          references.add(statement.property);
          for (const value of statement.values) if (value.ref) references.add(value.ref);
        }
        const labels = await resolveLabels([...references], ctx);
        const facts = statements.map((statement) => ({
          property: labels.get(statement.property) ?? statement.property,
          values: statement.values.map((value) =>
            value.ref ? (labels.get(value.ref) ?? value.ref) : value.text,
          ),
        }));

        const result = {
          id,
          label: typeof label === 'string' ? label : id,
          description: typeof description === 'string' ? description : null,
          aliases,
          url: `${BASE_URL}/wiki/${id}`,
          facts,
        };
        const factLines = facts
          .map((fact) => `  ${fact.property}: ${fact.values.join(', ')}`)
          .join('\n');
        const text = `[${result.id}] ${result.label}${result.description ? ` — ${result.description}` : ''}\n${factLines}`;
        return { text, structured: result };
      },
    },
  ],
});
