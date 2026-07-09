import { type ToolContext, ToolError } from '@ontrove/mcp';

/**
 * CKAN transport + localized-field helpers for the open.canada.ca action API.
 * Holds the base URL and User-Agent, maps CKAN's `{ success, result | error }`
 * envelope onto {@link ToolError}, and resolves the portal's bilingual
 * (`{ en, fr }`) fields to English for display.
 */

/** Base path for the open.canada.ca CKAN action API. */
const BASE_URL = 'https://open.canada.ca/data/api/3/action';

/** Descriptive User-Agent (open-data etiquette). Replace with your own contact before deploying. */
const CONTACT_EMAIL = 'trove-integrations@users.noreply.github.com';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

/** A CKAN response envelope: `{ success, result | error }`. */
type CkanEnvelope = { success?: boolean; result?: unknown; error?: unknown } | null;

/**
 * Map a CKAN error envelope (`{ success: false, error }`) to a non-retryable
 * {@link ToolError}, mirroring CKAN's own message. Returns `null` when the body
 * is not a recognizable success-false envelope.
 */
function ckanErrorFor(body: CkanEnvelope): ToolError | null {
  if (!body || typeof body !== 'object' || body.success) return null;
  const err = body.error as { message?: unknown; __type?: unknown } | undefined;
  const msg =
    (typeof err?.message === 'string' && err.message) ||
    (typeof err?.__type === 'string' && err.__type) ||
    'request rejected';
  return new ToolError(`Canada Open Data: ${msg}`, { retryable: false });
}

/**
 * GET a CKAN action and return its `result`. CKAN wraps every response in
 * `{ success, result | error }`; a `success: false` body (even with HTTP 200,
 * or on a 404/409) is surfaced as a non-retryable error. Other non-2xx is a
 * transient outage.
 */
export async function ckanGet(
  action: string,
  params: URLSearchParams,
  ctx: Pick<ToolContext, 'fetchJson'>,
): Promise<unknown> {
  const body = (await ctx.fetchJson(`${BASE_URL}/${action}?${params}`, {
    init: { headers: { accept: 'application/json', 'user-agent': USER_AGENT } },
    // CKAN returns JSON error envelopes for 404 (not found) and 409 (validation);
    // parse those for a precise message. Other non-2xx is a transient outage.
    errorMap: (res, text) => {
      if (res.status !== 404 && res.status !== 409) {
        return new ToolError('open.canada.ca is temporarily unavailable.', { retryable: true });
      }
      let parsed: CkanEnvelope;
      try {
        parsed = JSON.parse(text) as CkanEnvelope;
      } catch {
        parsed = null;
      }
      return (
        ckanErrorFor(parsed) ??
        new ToolError('open.canada.ca returned malformed data; try again shortly.', {
          retryable: true,
        })
      );
    },
  })) as CkanEnvelope;
  if (!body || typeof body !== 'object') {
    throw new ToolError('open.canada.ca returned malformed data; try again shortly.', {
      retryable: true,
    });
  }
  const envelopeError = ckanErrorFor(body);
  if (envelopeError) throw envelopeError;
  return body.result;
}

/** Resolve a CKAN localized field (`{ en, fr }` or string) to English. */
export function en(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const e = (value as { en?: unknown }).en;
    if (typeof e === 'string' && e.length > 0) return e;
  }
  return null;
}

/** The English half of a bilingual "English | Français" org/title string. */
export function englishHalf(value: unknown): string | null {
  const s = en(value);
  return s ? (s.split('|')[0] ?? s).trim() : null;
}

/** Human dataset landing page from its CKAN name (slug). */
export function landingUrl(name: unknown): string | null {
  return typeof name === 'string' ? `https://open.canada.ca/data/en/dataset/${name}` : null;
}

/** Distinct, upper-cased resource formats on a dataset. */
export function datasetFormats(resources: unknown): string[] {
  if (!Array.isArray(resources)) return [];
  const set = new Set<string>();
  for (const r of resources) {
    const f = (r as { format?: unknown }).format;
    if (typeof f === 'string' && f.length > 0) set.add(f.toUpperCase());
  }
  return [...set];
}
