import type { ToolContext } from '@ontrove/mcp';
import { createEgressClient } from '../lib/egress.ts';
import { htmlToText } from './html.ts';
import type { WcatDecision } from './shapes.ts';

/**
 * WCAT search client + result parsing. WCAT's "Search past decisions" page is a
 * server-rendered WordPress search (no JSON API); we drive it live and parse the
 * result list. Requests go through a shared egress client that supplies the
 * honest User-Agent, a polite throttle, retry/backoff, and an in-isolate cache.
 */

const SEARCH_URL = 'https://www.wcat.bc.ca/home/search-past-decisions/';
const USER_AGENT = 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)';

const wcat = createEgressClient({
  service: 'WCAT',
  headers: { accept: 'text/html', 'user-agent': USER_AGENT },
  throttleMs: 400, // ~1 request / 0.4s — well within polite scraping limits
});

const ITEM_RE = /<li>([\s\S]*?)<\/li>/g;
const PDF_RE = /href="(https:\/\/www\.wcat\.bc\.ca\/+decisions\/pdf\/\d{4}\/\d{2}\/[\w-]+\.pdf)"/;
const NUMBER_RE = /\/decisions\/pdf\/\d{4}\/\d{2}\/[\w-]+\.pdf"[^>]*>\s*([\w-]+)\s*</;
const DATE_RE = /Date<\/div>\s*<div>([^<]+)<\/div>/;
const APP_TYPE_RE = /Appeal or application type<\/div>\s*<div>([^<]*)<\/div>/;
const DOC_TYPE_RE = /Decision or document type<\/div>\s*<div>([^<]*)<\/div>/;
const ISSUES_RE = /Issues under appeal<\/div>\s*<p>([\s\S]*?)<\/p>/;

/** Parse a WCAT "Mon DD, YYYY" date to a UTC-midnight ISO string, avoiding a
 *  local-timezone day shift. Returns null when unparseable. */
function wcatDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(`${htmlToText(raw) ?? ''} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Parse one WCAT server-rendered results page into decisions. */
export function parseWcatPage(html: string): WcatDecision[] {
  const decisions: WcatDecision[] = [];
  for (const match of html.matchAll(ITEM_RE)) {
    const block = match[1] ?? '';
    const pdf = PDF_RE.exec(block);
    if (!pdf) continue; // non-result <li> (nav, pagination)
    const number = NUMBER_RE.exec(block)?.[1]?.trim();
    if (!number) continue;
    decisions.push({
      number,
      date: wcatDate(DATE_RE.exec(block)?.[1]?.trim() ?? null),
      applicationType: htmlToText(APP_TYPE_RE.exec(block)?.[1] ?? ''),
      documentType: htmlToText(DOC_TYPE_RE.exec(block)?.[1] ?? ''),
      issues: htmlToText(ISSUES_RE.exec(block)?.[1] ?? ''),
      pdfUrl: (pdf[1] ?? '').replace('bc.ca//', 'bc.ca/'),
    });
  }
  return decisions;
}

/**
 * Fetch and parse WCAT decisions for the given search params, newest-first,
 * paging (10/page) until `limit` is reached or results run out. Deduped by
 * decision number.
 */
export async function collectWcatDecisions(
  params: URLSearchParams,
  limit: number,
  ctx: ToolContext,
): Promise<WcatDecision[]> {
  const seen = new Set<string>();
  const out: WcatDecision[] = [];
  const maxPages = Math.ceil(limit / 10);
  for (let page = 1; page <= maxPages; page++) {
    const base = page > 1 ? `${SEARCH_URL}page/${page}/` : SEARCH_URL;
    const { status, body } = await wcat.fetch(ctx, `${base}?${params.toString()}`);
    if (status !== 200) break; // 400/404 → no more results (429/5xx already threw)
    const pageDecisions = parseWcatPage(body);
    if (pageDecisions.length === 0) break;
    for (const decision of pageDecisions) {
      if (seen.has(decision.number)) continue;
      seen.add(decision.number);
      out.push(decision);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Format a WCAT decision as one human-readable line. */
export function wcatLine(d: WcatDecision): string {
  const date = d.date ? d.date.slice(0, 10) : '?';
  const kind = [d.applicationType, d.documentType].filter(Boolean).join(' / ') || '?';
  return `  ${d.number} (${date}) [${kind}]: ${d.issues ?? '(no summary)'}\n    ${d.pdfUrl}`;
}
