/**
 * `search_series` — finding a FRED series id, and being able to tell the hits
 * apart once found.
 *
 * FRED's own ranking is `search_rank`, which leans hard on literal title
 * matches: "inflation" returns four frequencies of the same inflation-*indexed*
 * Treasury yield before it returns a price index. `orderBy` is therefore
 * exposed (`popularity` is the better prior for broad conceptual queries), and
 * every hit carries `popularity` so a caller can judge the ranking for itself.
 *
 * The SA/NSA collision is the other half: `CPIAUCSL` and `CPIAUCNS` share a
 * title, units and frequency, and differ only in seasonal adjustment. That
 * field is mapped onto every hit and spelled out in the prose.
 */
import type { ToolContext } from '@ontrove/mcp';
import { getJson, mapSeries, type SeriesMeta, seasonalPhrase } from './client.ts';

/** Validated arguments for one `search_series` call. */
export interface SearchArgs {
  text: string;
  limit: number;
  orderBy: string;
  seasonalAdjustment?: 'SA' | 'NSA';
  frequency?: string;
}

/**
 * Interrogatives, articles and auxiliaries FRED's keyword index has no use for.
 * Stripped only on a retry, after the literal query has already come back
 * empty — never on the first attempt, where they may be meaningful.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'many',
  'me',
  'much',
  'my',
  'of',
  'on',
  'or',
  'please',
  'show',
  'the',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'you',
]);

/** Reduce a natural-language question to the keywords FRED can actually match. */
export function keywordsOnly(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .join(' ');
}

/** Does this hit satisfy the caller's seasonal-adjustment / frequency filters? */
function matchesFilters(s: SeriesMeta, args: SearchArgs): boolean {
  if (args.seasonalAdjustment) {
    const code = s.seasonalAdjustment?.toUpperCase() ?? '';
    // A seasonally-adjusted annual rate is still seasonally adjusted; FRED's own
    // `filter_variable` treats SAAR as a separate value and would drop it.
    const wanted = args.seasonalAdjustment === 'SA' ? ['SA', 'SAAR'] : ['NSA'];
    if (!wanted.includes(code)) return false;
  }
  if (args.frequency && s.frequencyShort?.toLowerCase() !== args.frequency.toLowerCase()) {
    return false;
  }
  return true;
}

/** One page of FRED search results plus the size of the full matching set. */
interface SearchPage {
  hits: SeriesMeta[];
  totalMatches: number;
}

/** Query FRED once, then apply the client-side filters and trim to `limit`. */
async function searchOnce(text: string, args: SearchArgs, ctx: ToolContext): Promise<SearchPage> {
  const filtering = Boolean(args.seasonalAdjustment || args.frequency);
  // FRED's `filter_variable` accepts one filter at a time, so both are applied
  // here instead; over-fetch so filtering still fills the requested page.
  const fetchLimit = filtering ? Math.min(args.limit * 8, 1000) : args.limit;
  const params = new URLSearchParams({ search_text: text, limit: String(fetchLimit) });
  if (args.orderBy !== 'search_rank') params.set('order_by', args.orderBy);
  const body = await getJson('/series/search', params, ctx);
  const raw = Array.isArray(body.seriess) ? body.seriess : [];
  const all = raw.map((s) => mapSeries(s));
  const hits = all.filter((s) => matchesFilters(s, args)).slice(0, args.limit);
  return {
    hits,
    totalMatches: typeof body.count === 'number' ? body.count : all.length,
  };
}

/** Render one hit, with the seasonal adjustment that distinguishes it. */
function renderHit(s: SeriesMeta): string {
  const facts = [s.units, s.frequency, seasonalPhrase(s.seasonalAdjustment)].filter(Boolean);
  const coverage =
    s.observationStart && s.observationEnd ? ` [${s.observationStart}→${s.observationEnd}]` : '';
  return `  ${s.id} — ${s.title ?? ''}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}${coverage}`;
}

/** The advice attached to a search that matched nothing. */
function noMatchText(original: string, retried: string | null): string {
  const tried = retried ? ` (also tried "${retried}")` : '';
  return (
    `No FRED series matching "${original}"${tried}. FRED's index is keyword-based, not ` +
    'natural language — search the name of the measure ("house price index", ' +
    '"unemployment rate", "10-year treasury"), or a known series id.'
  );
}

/**
 * Run one `search_series` call.
 *
 * A query that matches nothing is retried once with interrogatives and articles
 * stripped ("how much do houses cost" → "houses cost"), because the empty
 * response is exactly where the keywords-not-questions hint is needed and a
 * caller has no reason to know it up front.
 */
export async function runSearch(
  args: SearchArgs,
  ctx: ToolContext,
): Promise<{ text: string; structured: unknown }> {
  let page = await searchOnce(args.text, args, ctx);
  let retried: string | null = null;
  if (page.hits.length === 0) {
    const stripped = keywordsOnly(args.text);
    if (stripped && stripped !== args.text.toLowerCase().trim()) {
      retried = stripped;
      page = await searchOnce(stripped, args, ctx);
    }
  }
  const base = {
    text: args.text,
    orderBy: args.orderBy,
    retriedAs: page.hits.length > 0 ? retried : null,
  };
  if (page.hits.length === 0) {
    return {
      text: noMatchText(args.text, retried),
      structured: { ...base, count: 0, totalMatches: 0, series: [] },
    };
  }
  const via = retried ? ` (matched on "${retried}")` : '';
  const more = page.totalMatches > page.hits.length ? ` of ${page.totalMatches} matches` : '';
  const header = `${page.hits.length}${more} FRED series for "${args.text}"${via}, by ${args.orderBy}:`;
  return {
    text: `${header}\n${page.hits.map((s) => renderHit(s)).join('\n')}`,
    structured: {
      ...base,
      count: page.hits.length,
      totalMatches: page.totalMatches,
      series: page.hits,
    },
  };
}
