import { type ToolContext, ToolError } from '@ontrove/extend/toolkit';
import {
  type Certificate,
  corTypeLabel,
  type EmployerHit,
  type PartnerCertifiedEmployer,
} from './shapes.ts';
import { accountNumber, cellText, decodeEntities, isExpired, isoDate } from './text.ts';

/**
 * Client for WorkSafeBC's public Certificate of Recognition app
 * (`corcp.online.worksafebc.com`).
 *
 * The app is ASP.NET MVC with Kendo grids and has no documented API, but the
 * grids are **server-paged against two JSON endpoints**, which this client calls
 * directly rather than scraping rendered rows:
 *  - `POST /Home/GetEmployerSearchResults`      → `{ Data, Total, Errors }`
 *  - `POST /Home/GetCertifyingPartnerEmployers` → `{ Data, Total, Errors }`
 *
 * Both demand an antiforgery pair — the `__RequestVerificationToken` hidden
 * field plus the cookie minted alongside it — so every call first GETs the
 * matching landing page. The pair is **per landing page**: a token minted on
 * `/Home/EmployerSearch` and sent to the certifying-partner endpoint 302s to
 * `/Error/Index` (verified live), so the two surfaces must not share a session.
 * Carrying `Set-Cookie` needs the raw headers, which the shared `getJson` helper
 * does not surface, so this uses `ctx.fetch` directly.
 *
 * `/Home/EmployerDetails` is the one surface with no JSON behind it and no
 * session requirement: it is fetched cookieless and parsed.
 */

export const BASE_URL = 'https://corcp.online.worksafebc.com';

const HTML_HEADERS: Record<string, string> = { accept: 'text/html' };

/** Landing pages, each minting the antiforgery pair for its own JSON endpoint. */
export const SEARCH_PAGE = `${BASE_URL}/Home/EmployerSearch`;
export const PARTNER_PAGE = `${BASE_URL}/`;

const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]*)"/;
/** One `<option value="000810731">NAME</option>` in the certifying-partner select. */
const PARTNER_OPTION_RE = /<option value="(\d+)"\s*>([^<]*)<\/option>/g;
/** A certificate row: four plain cells, then the nested classification-unit grid. */
const CERT_ROW_RE =
  /<tr class="[^"]*k-master-row"><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td>/g;
/** A classification-unit row: exactly two cells, closing the row immediately. */
const CU_ROW_RE = /<tr class="[^"]*k-master-row"><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g;
/**
 * The employer's names. Each sits in a `<strong>` inside the cell *after* its
 * `<label for="…">`, so the anchor is the label's `for` attribute and the value
 * is the next `<strong>` — matching on the label text and taking the next `<div>`
 * picks up the whitespace between the cell and the `<strong>` instead.
 */
const LEGAL_NAME_RE = /for="LegalName"[\s\S]{0,300}?<strong>([\s\S]*?)<\/strong>/;
const TRADE_NAME_RE = /for="TradeName"[\s\S]{0,300}?<strong>([\s\S]*?)<\/strong>/;

/** The antiforgery pair for one landing page. */
export interface Session {
  token: string;
  cookie: string;
}

/** GET a landing page, returning its HTML plus the antiforgery pair it minted. */
export async function getSession(
  page: string,
  ctx: ToolContext,
): Promise<Session & { html: string }> {
  const res = await ctx.fetch(page, { headers: { ...HTML_HEADERS } });
  if (!res.ok) {
    throw new ToolError('The WorkSafeBC COR registry is temporarily unavailable.', {
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const html = await res.text();
  const token = TOKEN_RE.exec(html)?.[1];
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';', 1)[0])
    .filter((pair): pair is string => Boolean(pair))
    .join('; ');
  if (!token || !cookie) {
    throw new ToolError('The WorkSafeBC COR registry did not return a usable session.', {
      retryable: true,
    });
  }
  return { token: decodeEntities(token), cookie, html };
}

/** Read the certifying-partner `<select>` off the landing page HTML. */
export function parsePartners(html: string): { id: string; name: string }[] {
  return [...html.matchAll(PARTNER_OPTION_RE)]
    .map((match) => ({ id: match[1] ?? '', name: cellText(match[2] ?? '') ?? '' }))
    .filter((partner) => partner.id !== '' && partner.name !== '');
}

/** One row of either Kendo grid (the two endpoints share a row shape by field name). */
interface GridRow {
  EmployerId?: unknown;
  AccountNumber?: unknown;
  LegalName?: unknown;
  TradeName?: unknown;
  CORTypeCode?: unknown;
  CertificateNumber?: unknown;
  ExpiryDate?: unknown;
  CUCode?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** `/Home/EmployerDetails?employerId=200213040` in a redirect Location. */
const DETAILS_REDIRECT_RE = /\/Home\/EmployerDetails\?employerId=(\d+)/;

/** What a grid POST came back as: rows, or a redirect to one employer's page. */
export type GridResponse =
  | { kind: 'rows'; rows: GridRow[]; total: number }
  | { kind: 'singleMatch'; employerId: number };

/**
 * Classify a grid POST's redirect.
 *
 * Measured, not assumed: a search matching **exactly one** employer does not
 * return a one-row grid — it 302s to that employer's details page
 * (`"al stober"`, `"van belle nursery"`, `"leddy firewood"` and `"teck"` all
 * do). Treating every 3xx as a failure therefore broke the single most likely
 * query this tool receives: "is *this* firm certified?". A redirect to
 * `/Error/Index` is still a failure; one to `/Home/EmployerDetails` is the
 * answer.
 */
function classifyRedirect(res: Response): GridResponse {
  const location = res.headers.get('location') ?? '';
  const employerId = DETAILS_REDIRECT_RE.exec(location)?.[1];
  if (employerId !== undefined) return { kind: 'singleMatch', employerId: Number(employerId) };
  throw new ToolError('The WorkSafeBC COR registry rejected the request; try again.', {
    retryable: true,
  });
}

/** POST one page of a Kendo grid and return its rows plus the reported total. */
export async function fetchGrid(
  endpoint: string,
  parameters: Record<string, string>,
  session: Session,
  ctx: ToolContext,
): Promise<GridResponse> {
  const res = await ctx.fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      cookie: session.cookie,
    },
    body: new URLSearchParams({
      __RequestVerificationToken: session.token,
      ...parameters,
    }).toString(),
  });
  if (res.status >= 300 && res.status < 400) return classifyRedirect(res);
  if (!res.ok) {
    throw new ToolError(`The WorkSafeBC COR registry returned HTTP ${res.status}.`, {
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ToolError('The WorkSafeBC COR registry returned malformed data; try again.', {
      retryable: true,
    });
  }
  const parsed = (body ?? {}) as { Data?: unknown; Total?: unknown; Errors?: unknown };
  // `Errors` has been null on every observed success. It is read anyway rather than
  // ignored: a payload that carried an error alongside a null `Data` would otherwise
  // be reported as "no matches".
  if (parsed.Errors !== null && parsed.Errors !== undefined) {
    throw new ToolError(
      `The WorkSafeBC COR registry reported an error: ${String(parsed.Errors).slice(0, 200)}`,
      { retryable: false },
    );
  }
  const rows = (Array.isArray(parsed.Data) ? parsed.Data : []).map((row) =>
    typeof row === 'object' && row !== null ? (row as GridRow) : {},
  );
  return {
    kind: 'rows',
    rows,
    total: typeof parsed.Total === 'number' ? parsed.Total : rows.length,
  };
}

/** A `<br/>` in any of the forms this app emits, including its malformed `</br/>`. */
const BR_RE = /<\/?br\s*\/?>/i;

/**
 * Split a certifying-partner grid cell on its `<br/>` separator.
 *
 * The partner grid declares two of its columns `encoded: false` and packs two
 * values into each: `LegalName` carries `LEGAL</br/><i>TRADE</i>` (131 of 739
 * sampled rows) and `CUCode` carries `721028<br/>761033`. Stripping the tags
 * without splitting first merged a legal and a trade name into one string and
 * turned a two-unit code into the single literal `"721028<br/>761033"` — both
 * confidently wrong values under a correct-looking label.
 */
const splitCell = (value: string | null): string[] =>
  (value ?? '')
    .split(BR_RE)
    .map((part) => cellText(part))
    .filter((part): part is string => part !== null);

/** Project a grid row onto the employer identity fields. */
export function toEmployerHit(row: GridRow): EmployerHit {
  const id = typeof row.EmployerId === 'number' ? row.EmployerId : null;
  // The search grid keeps the two names in separate fields; the partner grid packs
  // both into `LegalName`. Prefer an explicit `TradeName`, fall back to the packed one.
  const [legalName, packedTradeName] = splitCell(asString(row.LegalName));
  return {
    employerId: id,
    accountNumber: asString(row.AccountNumber) ?? (id === null ? null : accountNumber(id)),
    legalName: legalName ?? null,
    tradeName: cellText(asString(row.TradeName) ?? '') ?? packedTradeName ?? null,
    url: id === null ? null : `${BASE_URL}/Home/EmployerDetails?employerId=${id}`,
  };
}

/** Project a certifying-partner grid row, which carries its certificate inline. */
export function toPartnerCertifiedEmployer(row: GridRow): PartnerCertifiedEmployer {
  const expiryDate = isoDate(asString(row.ExpiryDate));
  return {
    ...toEmployerHit(row),
    corType: corTypeLabel(asString(row.CORTypeCode)),
    certificateNumber: asString(row.CertificateNumber),
    expiryDate,
    expired: isExpired(expiryDate),
    classificationUnits: splitCell(asString(row.CUCode)).flatMap((unit) =>
      unit.split(/[\s,]+/).filter((code) => code !== ''),
    ),
  };
}

/** A parsed certificate together with where its row started in the document. */
interface PlacedCertificate {
  at: number;
  certificate: Certificate;
}

/** Parse the certificate rows — the ones opening with four plain cells. */
function parseCertificateRows(html: string): PlacedCertificate[] {
  return [...html.matchAll(CERT_ROW_RE)].map((match) => {
    const expiryDate = isoDate(cellText(match[4] ?? ''));
    return {
      at: match.index,
      certificate: {
        certifyingPartner: cellText(match[1] ?? ''),
        corType: corTypeLabel(cellText(match[2] ?? '')),
        certificateNumber: cellText(match[3] ?? ''),
        expiryDate,
        expired: isExpired(expiryDate),
        classificationUnits: [],
      },
    };
  });
}

/** The certificate a nested row at `index` belongs to: the last one opened before it. */
function certificateAt(placed: PlacedCertificate[], index: number): Certificate | undefined {
  let owner: Certificate | undefined;
  for (const entry of placed) {
    if (entry.at > index) break;
    owner = entry.certificate;
  }
  return owner;
}

/**
 * Parse the certificates grid off an employer-details page.
 *
 * The two row shapes are told apart by cell count — a certificate row opens
 * with four plain cells before the nested grid, a classification-unit row has
 * exactly two and closes immediately — and each unit is attributed to the last
 * certificate that started before it, so an employer holding two certificates
 * does not collect the other's units.
 */
export function parseCertificates(html: string): Certificate[] {
  const placed = parseCertificateRows(html);
  for (const match of html.matchAll(CU_ROW_RE)) {
    const code = cellText(match[1] ?? '');
    if (!code) continue;
    certificateAt(placed, match.index)?.classificationUnits.push({
      code,
      description: cellText(match[2] ?? ''),
    });
  }
  return placed.map((entry) => entry.certificate);
}

/** One employer's details page, parsed. */
export interface EmployerDetails {
  legalName: string | null;
  tradeName: string | null;
  certificates: Certificate[];
}

/**
 * Fetch and parse one employer's details page.
 *
 * An unknown employer number 302s to `/Error/Index` rather than 404ing, so the
 * redirect is not followed: the error page contains no certificate rows and
 * would otherwise parse as "this employer holds no COR" — a wrong answer to the
 * question this tool exists to answer.
 */
export async function fetchEmployerDetails(
  employerId: string,
  ctx: ToolContext,
): Promise<EmployerDetails> {
  const res = await ctx.fetch(`${BASE_URL}/Home/EmployerDetails?employerId=${employerId}`, {
    headers: { ...HTML_HEADERS },
    redirect: 'manual',
  });
  if (!res.ok || res.status >= 300) {
    throw new ToolError(
      res.status >= 500
        ? 'The WorkSafeBC COR registry is temporarily unavailable.'
        : `WorkSafeBC has no COR record for employer number ${employerId}.`,
      { retryable: res.status >= 500 },
    );
  }
  const html = await res.text();
  if (html.includes('/Error/Index') && !html.includes('Employer legal name')) {
    throw new ToolError(`WorkSafeBC has no COR record for employer number ${employerId}.`, {
      retryable: false,
    });
  }
  return {
    legalName: cellText(LEGAL_NAME_RE.exec(html)?.[1] ?? ''),
    tradeName: cellText(TRADE_NAME_RE.exec(html)?.[1] ?? ''),
    certificates: parseCertificates(html),
  };
}
