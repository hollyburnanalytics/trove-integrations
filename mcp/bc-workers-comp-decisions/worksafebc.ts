import { type ToolContext, ToolError } from '@ontrove/mcp';
import { htmlToText } from './html.ts';
import type { ReviewDecision } from './shapes.ts';

/**
 * WorkSafeBC Review Division search client. The search app
 * (rdpubsearch.online.worksafebc.com, ASP.NET) has no JSON API, so the tool
 * submits its public search form exactly as a browser would: a landing GET
 * returns the form's anti-CSRF token + cookie, and the POST sends them back with
 * the query. The result then arrives via Post-Redirect-Get. Because that flow
 * needs the Set-Cookie headers (which the shared egress client does not surface)
 * and must carry the session cookie across the redirect, it uses `ctx.fetch`
 * directly — up to three requests per call, on a constant hardcoded host.
 */

const BASE_URL = 'https://rdpubsearch.online.worksafebc.com/';
const USER_AGENT = 'TroveBot/0.1 (+https://github.com/hollyburnanalytics/trove-integrations)';
const HTML_HEADERS: Record<string, string> = { accept: 'text/html', 'user-agent': USER_AGENT };
const RESULT_CAP = 1000; // WorkSafeBC's hard per-query maximum

const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]*)"/;
const ROW_RE = /<tr id="row-\d+">([\s\S]*?)<\/tr>/g;
const CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const TOTAL_RE = /([\d,]+)\s+results?/i;

/** Parse a WorkSafeBC "YYYY-MM-DD" date to an ISO string (parsed as UTC per spec). */
function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Result of a Review Division search: decisions plus the reported total. */
export interface ReviewSearchResult {
  decisions: ReviewDecision[];
  total: number | null;
  /** True when the query hit WorkSafeBC's 1000-result cap (older matches unreachable). */
  truncated: boolean;
}

/** GET the landing page and extract the antiforgery token + paired cookie. */
async function getSession(ctx: ToolContext): Promise<{ token: string; cookie: string }> {
  const res = await ctx.fetch(BASE_URL, { headers: { ...HTML_HEADERS } });
  if (!res.ok) {
    throw new ToolError('WorkSafeBC Review search is temporarily unavailable.', {
      retryable: res.status >= 500,
    });
  }
  const html = await res.text();
  const token = TOKEN_RE.exec(html)?.[1];
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
  if (!token || !cookie) {
    throw new ToolError('WorkSafeBC Review search did not return a usable session.', {
      retryable: true,
    });
  }
  return { token, cookie };
}

/** Merge `name=value` pairs from a Cookie header with Set-Cookie values (new wins). */
function mergeCookies(cookieHeader: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  const add = (pair: string) => {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  };
  for (const pair of cookieHeader.split('; ')) add(pair);
  for (const setCookie of setCookies) add(setCookie.split(';')[0] ?? '');
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Retrieve the results HTML for a submitted search. WorkSafeBC uses
 * Post-Redirect-Get: the POST stores the result set under a NEW `.AspNetCore.Session`
 * cookie and 302-redirects to `/`. `fetch` follows the redirect but does not carry
 * a Set-Cookie across it, so we follow it manually, merging the session cookie in —
 * otherwise the redirected GET renders the empty search form (zero results).
 */
async function fetchResultsHtml(post: Response, cookie: string, ctx: ToolContext): Promise<string> {
  if (post.status >= 300 && post.status < 400) {
    const merged = mergeCookies(cookie, post.headers.getSetCookie?.() ?? []);
    const location = new URL(post.headers.get('location') ?? '/', BASE_URL).toString();
    const res = await ctx.fetch(location, { headers: { ...HTML_HEADERS, cookie: merged } });
    if (!res.ok) {
      throw new ToolError(`WorkSafeBC Review results are unavailable (HTTP ${res.status}).`, {
        retryable: res.status >= 500,
      });
    }
    return res.text();
  }
  if (!post.ok) {
    throw new ToolError(`WorkSafeBC Review search failed (HTTP ${post.status}).`, {
      retryable: post.status >= 500,
    });
  }
  return post.text();
}

/** Search the Review Division for `keyword`, newest-first, up to `limit` rows. */
export async function searchReview(
  keyword: string,
  limit: number,
  ctx: ToolContext,
): Promise<ReviewSearchResult> {
  const { token, cookie } = await getSession(ctx);
  const body = new URLSearchParams({
    Keyword: keyword,
    SortBy: 'DocumentCreationDate',
    SortDir: 'desc',
    PageSize: String(limit),
    command: '',
    __RequestVerificationToken: token,
  }).toString();

  const post = await ctx.fetch(BASE_URL, {
    method: 'POST',
    redirect: 'manual', // WorkSafeBC uses Post-Redirect-Get — follow it ourselves (see below)
    headers: {
      ...HTML_HEADERS,
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
    },
    body,
  });
  if (post.status === 429) {
    throw new ToolError('WorkSafeBC is rate-limiting; try again shortly.', { retryable: true });
  }
  const html = await fetchResultsHtml(post, cookie, ctx);

  const decisions: ReviewDecision[] = [];
  for (const rowMatch of html.matchAll(ROW_RE)) {
    const cells = [...(rowMatch[1] ?? '').matchAll(CELL_RE)].map((m) => m[1] ?? '');
    const number = htmlToText(cells[0] ?? '');
    if (!number) continue;
    decisions.push({
      number,
      date: isoDate(htmlToText(cells[2] ?? '')),
      snippet: htmlToText(cells[1] ?? ''),
    });
    if (decisions.length >= limit) break;
  }

  const totalRaw = TOTAL_RE.exec(html)?.[1];
  const total = totalRaw ? Number.parseInt(totalRaw.replace(/,/g, ''), 10) : null;
  return { decisions, total, truncated: total !== null && total >= RESULT_CAP };
}
