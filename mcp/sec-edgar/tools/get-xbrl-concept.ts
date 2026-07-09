import { type ToolContext, type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import {
  type Company,
  companyConceptUrl,
  companyFactsUrl,
  edgarJson,
  fmtMoney,
  requireCompany,
} from '../client.ts';
import {
  factsForUnit,
  fiscalStampsTrusted,
  kindOf,
  latestFiledByPeriod,
  pickUnitKey,
} from '../facts.ts';

/**
 * `get_xbrl_concept` — one XBRL concept's full value history, plus a discovery
 * mode (`search`) that lists which tags a company actually reports.
 */

/** One discovered XBRL tag, summarizing how much data the company reports for it. */
interface DiscoveredConcept {
  tag: string;
  label: string | null;
  units: string[];
  factCount: number;
  latestEnd: string | null;
}

/** Summarize one taxonomy tag's units, fact count, and latest reported period. */
function summarizeTag(entry: {
  label?: unknown;
  units?: Record<string, unknown>;
}): Omit<DiscoveredConcept, 'tag'> {
  const units = Object.keys(entry.units ?? {});
  let factCount = 0;
  let latestEnd: string | null = null;
  for (const unit of units) {
    const facts = entry.units?.[unit];
    if (!Array.isArray(facts)) continue;
    factCount += facts.length;
    for (const fact of facts) {
      const end = (fact as { end?: unknown }).end;
      if (typeof end === 'string' && (latestEnd === null || end > latestEnd)) latestEnd = end;
    }
  }
  return {
    label: typeof entry.label === 'string' ? entry.label : null,
    units,
    factCount,
    latestEnd,
  };
}

/** Collect the tags whose name contains `needle` and that carry at least one fact. */
function collectMatchingConcepts(
  taxFacts: Record<string, { label?: unknown; units?: Record<string, unknown> }> | undefined,
  needle: string,
): DiscoveredConcept[] {
  const found: DiscoveredConcept[] = [];
  for (const [tag, entry] of Object.entries(taxFacts ?? {})) {
    if (!tag.toLowerCase().includes(needle)) continue;
    const summary = summarizeTag(entry);
    if (summary.factCount === 0) continue;
    found.push({ tag, ...summary });
  }
  return found;
}

/**
 * Discovery mode for get_xbrl_concept: list the tags a company actually
 * reports (from companyfacts) whose name matches a substring, ranked by how
 * much data each carries.
 */
async function discoverConcepts(
  ctx: ToolContext,
  resolved: Company,
  taxonomy: string,
  search: string,
  limit: number,
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const body = await edgarJson(
    ctx,
    companyFactsUrl(resolved.cik),
    `SEC EDGAR has no XBRL company facts for CIK ${resolved.cik}.`,
  );
  const name = typeof body.entityName === 'string' ? body.entityName : resolved.name;
  const taxFacts = ((body.facts ?? {}) as Record<string, unknown>)[taxonomy] as
    | Record<string, { label?: unknown; units?: Record<string, unknown> }>
    | undefined;
  const found = collectMatchingConcepts(taxFacts, search.toLowerCase());
  found.sort((a, b) => b.factCount - a.factCount);
  const concepts = found.slice(0, limit);

  const lines = concepts
    .map(
      (c) =>
        `  ${c.tag} — ${c.factCount} fact(s), ${c.units.join('/')}` +
        `${c.latestEnd ? `, latest ${c.latestEnd}` : ''}${c.label ? `\n    ${c.label}` : ''}`,
    )
    .join('\n');
  const text =
    concepts.length > 0
      ? `${name} reports ${found.length} ${taxonomy} tag(s) matching "${search}"` +
        `${found.length > concepts.length ? ` (showing top ${concepts.length})` : ''}:\n${lines}\n` +
        'Call again with concept=<tag> for the full value history.'
      : `${name} reports no ${taxonomy} tags matching "${search}". Try a shorter fragment.`;
  return {
    text,
    structured: {
      company: name,
      cik: resolved.cik,
      concept: '',
      taxonomy,
      label: null,
      description: null,
      unit: '',
      total: found.length,
      count: concepts.length,
      facts: [],
      concepts,
    },
  };
}

const conceptFactShape = z.object({
  start: z.string().nullable(),
  end: z.string(),
  value: z.number(),
  fiscalYear: z.number().nullable(),
  fiscalPeriod: z.string().nullable(),
  form: z.string(),
  filed: z.string(),
  accession: z.string(),
  frame: z.string().nullable(),
});

export const getXbrlConcept: ToolDefinition = {
  name: 'get_xbrl_concept',
  title: 'EDGAR: One XBRL concept over time',
  description:
    'Every value a company has reported for a single XBRL concept (exact tag, e.g. ' +
    '"NetIncomeLoss", "Revenues", "Assets", "PaymentsToAcquirePropertyPlantAndEquipment"), ' +
    "across all years and quarters — ideal for one metric's full history or a metric " +
    "get_financials doesn't cover. Duplicate reports of the same period are deduped " +
    "to the latest filing (amendments win). Don't know the exact tag? Pass `search` " +
    'instead of `concept` (e.g. search "Revenue") to discover which tags the company ' +
    'actually reports, with fact counts. Use get_financials first when you need ' +
    'whole statements.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    company: z.string().min(1).describe('Ticker ("AAPL", "BRK.B"), company name, or CIK.'),
    concept: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .optional()
      .describe('Exact XBRL tag in CamelCase, e.g. "NetIncomeLoss".'),
    search: z
      .string()
      .min(2)
      .optional()
      .describe(
        'Discovery mode: list the tags this company reports whose name contains this ' +
          'text (e.g. "Revenue", "Lease"), instead of fetching one concept.',
      ),
    taxonomy: z
      .enum(['us-gaap', 'ifrs-full', 'dei', 'srt'])
      .default('us-gaap')
      .describe('Concept taxonomy; "us-gaap" for almost all US filers.'),
    period: z
      .enum(['annual', 'quarterly', 'all'])
      .default('all')
      .describe('Restrict to annual or quarterly windows, or return everything.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('How many most-recent facts (or discovered tags) to return (1–100).'),
  }),
  output: z.object({
    company: z.string(),
    cik: z.string(),
    concept: z.string(),
    taxonomy: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    unit: z.string(),
    total: z.number(),
    count: z.number(),
    facts: z.array(conceptFactShape),
    concepts: z.array(
      z.object({
        tag: z.string(),
        label: z.string().nullable(),
        units: z.array(z.string()),
        factCount: z.number(),
        latestEnd: z.string().nullable(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const { company, concept, search, taxonomy, period, limit } = args;
    ctx.log('get_xbrl_concept', { company, concept, search, taxonomy, period });
    if (!concept && !search) {
      throw new ToolError(
        'Pass `concept` (an exact XBRL tag) or `search` (to discover available tags).',
        { retryable: false },
      );
    }
    const resolved = await requireCompany(ctx, company);
    if (!concept) {
      return discoverConcepts(ctx, resolved, taxonomy, search as string, limit);
    }
    const body = await edgarJson(
      ctx,
      companyConceptUrl(resolved.cik, taxonomy, concept),
      `No "${taxonomy}:${concept}" facts for CIK ${resolved.cik}. XBRL tags are ` +
        'exact and case-sensitive (e.g. "NetIncomeLoss", not "netIncomeLoss"). To see ' +
        `which tags this company reports, call again with search="${concept.slice(0, 20)}" ` +
        'instead of concept.',
    );
    const name = typeof body.entityName === 'string' ? body.entityName : resolved.name;
    const units = (body.units ?? {}) as Record<string, unknown>;
    const unitKey = pickUnitKey(units, ['USD', 'USD/shares', 'shares']);
    if (!unitKey) {
      throw new ToolError(`"${concept}" exists but has no reported values.`, {
        retryable: false,
      });
    }
    const deduped = [...latestFiledByPeriod(factsForUnit(units, unitKey)).values()].filter(
      (fact) => period === 'all' || kindOf(fact) === period,
    );
    deduped.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
    const facts = deduped.slice(0, limit);

    const label = typeof body.label === 'string' ? body.label : null;
    const money = unitKey === 'USD' || /^[A-Z]{3}$/.test(unitKey);
    const lines = facts
      .map((fact) => {
        const window = fact.start ? `${fact.start} → ${fact.end}` : `as of ${fact.end}`;
        const factKind = kindOf(fact);
        // fy/fp describe the FILING; only trust them for facts filed near
        // their window end (comparatives inherit the later filing's stamps).
        const trusted =
          fact.fiscalYear !== null &&
          fact.fiscalPeriod !== null &&
          fiscalStampsTrusted(factKind === 'annual' ? 'annual' : 'quarterly', fact);
        const fiscal = trusted
          ? fact.fiscalPeriod === 'FY'
            ? ` (FY${fact.fiscalYear}, ${fact.form})`
            : ` (${fact.fiscalPeriod} FY${fact.fiscalYear}, ${fact.form})`
          : ` (${fact.form})`;
        const value = money ? fmtMoney(fact.value, unitKey) : String(fact.value);
        return `  ${window}${fiscal}: ${value}`;
      })
      .join('\n');
    return {
      text:
        `${name} — ${label ?? concept} [${taxonomy}:${concept}], ${unitKey}:\n` +
        (lines || '  (no facts matched the period filter)'),
      structured: {
        company: name,
        cik: resolved.cik,
        concept,
        taxonomy,
        label,
        description: typeof body.description === 'string' ? body.description : null,
        unit: unitKey,
        total: deduped.length,
        count: facts.length,
        facts,
        concepts: [],
      },
    };
  },
};
