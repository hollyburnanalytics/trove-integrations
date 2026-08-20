import type { ToolContext } from '@ontrove/extend/toolkit';
import { ToolError, z } from '@ontrove/extend/toolkit';
import { getJson } from '../lib/http.ts';

/**
 * OrgBook BC — a hosted MCP server over the BC government's public registry of
 * legal entities (orgbook.gov.bc.ca), the verifiable-credential mirror of the
 * BC Corporate Registry. Keyless and read-only; three tools:
 *  - `search_entities` — ranked name search across ~1.5M registrations,
 *  - `get_entity` — exact lookup by registration number (BC…, FM…, S…, CP…),
 *  - `get_entity_history` — the credential timeline (name changes, business
 *    number, status transitions) behind one registration.
 *
 * The natural counterpart to `jonas-premier`'s vendor records: confirm a
 * counterparty's legal name, registration number, and Active/Historical status
 * before money moves.
 *
 * API notes (probed live): a topic *is* a registration; the v4 search result
 * already carries names (entity_name + business_number) and typed attributes
 * (entity_status ACT/HIS, entity_type code, registration_date,
 * home_jurisdiction). There is no lookup-by-source-id endpoint, but searching
 * the registration number returns it as the only hit — `get_entity` does that
 * and then insists on an exact source_id match. Multi-word queries match ANY
 * word (totals look huge); results are relevance-ranked, so the matches that
 * matter come first.
 */

/** Base host for the OrgBook BC API. */
export const BASE_URL = 'https://orgbook.gov.bc.ca';

/** Human-readable web page for one registration. */
export const entityUrl = (sourceId: string): string => `${BASE_URL}/entity/${sourceId}`;

/** BC Registries entity-status codes. */
export const STATUS_LABEL: Record<string, string> = {
  ACT: 'Active',
  HIS: 'Historical',
};

/** Common BC Registries entity-type codes (fallback: the raw code). */
export const TYPE_LABEL: Record<string, string> = {
  BC: 'BC Company',
  C: 'Continued-In Company',
  ULC: 'Unlimited Liability Company',
  CC: 'Community Contribution Company',
  CP: 'Cooperative Association',
  GP: 'General Partnership',
  SP: 'Sole Proprietorship',
  S: 'Society',
  A: 'Extraprovincial Company',
  LLC: 'Extraprovincial Limited Liability Company',
  LP: 'Limited Partnership',
  XP: 'Extraprovincial Limited Partnership',
  LL: 'Limited Liability Partnership',
  FI: 'Financial Institution',
};

/** One mapped registration record (from a v4 search result). */
export interface EntityRecord {
  topicId: number | null;
  registrationNumber: string | null;
  entityName: string | null;
  businessNumber: string | null;
  entityStatus: string | null;
  entityType: string | null;
  homeJurisdiction: string | null;
  registrationDate: string | null;
  url: string | null;
}

/** Read a `names[]` entry of one type (entity_name / business_number). */
export function nameOfType(row: Record<string, unknown>, type: string): string | null {
  const names = Array.isArray(row.names) ? row.names : [];
  for (const entry of names) {
    const n = (entry ?? {}) as Record<string, unknown>;
    if (n.type === type && typeof n.text === 'string' && n.text !== '') return n.text;
  }
  return null;
}

/** Read an `attributes[]` value of one type (entity_status, registration_date…). */
export function attrOfType(row: Record<string, unknown>, type: string): string | null {
  const attributes = Array.isArray(row.attributes) ? row.attributes : [];
  for (const entry of attributes) {
    const a = (entry ?? {}) as Record<string, unknown>;
    if (a.type === type && typeof a.value === 'string' && a.value !== '') return a.value;
  }
  return null;
}

/** Map one v4 search result row to the tool-facing record. */
export function toEntity(row: Record<string, unknown>): EntityRecord {
  const sourceId = typeof row.source_id === 'string' && row.source_id !== '' ? row.source_id : null;
  const status = attrOfType(row, 'entity_status');
  const type = attrOfType(row, 'entity_type');
  return {
    topicId: typeof row.id === 'number' ? row.id : null,
    registrationNumber: sourceId,
    entityName: nameOfType(row, 'entity_name'),
    businessNumber: nameOfType(row, 'business_number'),
    entityStatus: status ? (STATUS_LABEL[status] ?? status) : null,
    entityType: type ? (TYPE_LABEL[type] ?? type) : null,
    homeJurisdiction: attrOfType(row, 'home_jurisdiction'),
    registrationDate: attrOfType(row, 'registration_date'),
    url: sourceId ? entityUrl(sourceId) : null,
  };
}

/** GET a v4 topic search page. */
export async function searchTopics(
  query: string,
  page: number,
  pageSize: number,
  ctx: ToolContext,
): Promise<{ total: number; rows: Record<string, unknown>[] }> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    page_size: String(pageSize),
  });
  const body = await getJson(`${BASE_URL}/api/v4/search/topic?${params}`, ctx, {
    service: 'OrgBook BC',
  });
  const rows = (Array.isArray(body.results) ? body.results : []).map((r) =>
    typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {},
  );
  return { total: typeof body.total === 'number' ? body.total : rows.length, rows };
}

/** Resolve a registration number to its (exactly matching) search row. */
export async function findByRegistrationNumber(
  registrationNumber: string,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const wanted = registrationNumber.trim().toUpperCase();
  const { rows } = await searchTopics(wanted, 1, 10, ctx);
  const match = rows.find(
    (r) => typeof r.source_id === 'string' && r.source_id.toUpperCase() === wanted,
  );
  if (!match) {
    throw new ToolError(
      `No BC registration "${wanted}" in OrgBook. Registration numbers look like BC0112233, ` +
        'FM0445566, or S0012345 — use search_entities to find one by name.',
      { retryable: false },
    );
  }
  return match;
}

/** The Zod shape of an EntityRecord (shared by all three tools). */
export const entityShape = {
  topicId: z.number().nullable(),
  registrationNumber: z.string().nullable(),
  entityName: z.string().nullable(),
  businessNumber: z.string().nullable(),
  entityStatus: z.string().nullable(),
  entityType: z.string().nullable(),
  homeJurisdiction: z.string().nullable(),
  registrationDate: z.string().nullable(),
  url: z.string().nullable(),
};

/** One text line summarizing an entity. */
export const entityLine = (e: EntityRecord): string =>
  `  ${e.registrationNumber ?? '?'} — ${e.entityName ?? '?'} ` +
  `[${e.entityStatus ?? '?'}${e.entityType ? ` · ${e.entityType}` : ''}]`;

/** Map one raw credential entry (from a credential-set) to the tool-facing shape. */
export function mapCredential(entry: unknown) {
  const c = (entry ?? {}) as Record<string, unknown>;
  const credType = (c.credential_type ?? {}) as Record<string, unknown>;
  const schemaLabel = (credType.schema_label ?? {}) as Record<string, unknown>;
  const en = (schemaLabel.en ?? {}) as Record<string, unknown>;
  const names = (Array.isArray(c.names) ? c.names : [])
    .map((n) => (n ?? {}) as Record<string, unknown>)
    .filter((n) => typeof n.text === 'string' && n.text !== '')
    .map((n) => ({
      text: n.text as string,
      type: typeof n.type === 'string' ? n.type : null,
    }));
  const attributes = (Array.isArray(c.attributes) ? c.attributes : [])
    .map((a) => (a ?? {}) as Record<string, unknown>)
    .filter((a) => typeof a.type === 'string' && typeof a.value === 'string')
    .map((a) => ({ type: a.type as string, value: a.value as string }));
  return {
    type: typeof en.label === 'string' ? en.label : null,
    effectiveDate: typeof c.effective_date === 'string' ? c.effective_date : null,
    latest: typeof c.latest === 'boolean' ? c.latest : null,
    revoked: typeof c.revoked === 'boolean' ? c.revoked : null,
    revokedDate: typeof c.revoked_date === 'string' ? c.revoked_date : null,
    names,
    attributes,
  };
}

/** Flatten OrgBook's credential-set response into mapped credentials. */
export function parseCredentialSets(body: unknown): ReturnType<typeof mapCredential>[] {
  const sets = Array.isArray(body) ? body : [];
  return sets
    .flatMap((set) => {
      const s = (set ?? {}) as Record<string, unknown>;
      return Array.isArray(s.credentials) ? s.credentials : [];
    })
    .map(mapCredential);
}
