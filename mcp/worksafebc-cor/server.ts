import { defineToolkit } from '@ontrove/extend/toolkit';
import { listCertifiedEmployers, listCertifyingPartners } from './tools/certifying-partners.ts';
import { getEmployerCertificates } from './tools/get-employer-certificates.ts';
import { searchEmployers } from './tools/search-employers.ts';

/**
 * WorkSafeBC COR Registry — a no-auth hosted MCP server over WorkSafeBC's public
 * Certificate of Recognition search (`corcp.online.worksafebc.com`), the
 * occupational-health-and-safety counterpart to `orgbook-bc`: OrgBook says a
 * firm is *registered*, this says whether its safety program is *certified*, by
 * whom, and until when.
 *
 * Four read-only tools:
 *  - `search_employers`          — COR-certified employers by legal or trade name,
 *  - `get_employer_certificates` — one employer's certificates + classification units,
 *  - `list_certifying_partners`  — the certifying partners (BCCSA, BCMSA, …),
 *  - `list_certified_employers`  — every employer one partner has certified.
 *
 * The app has no documented API; its Kendo grids are server-paged against two
 * JSON endpoints, which the client calls directly (see `corcp.ts` for the
 * antiforgery flow and the redirect trap behind it). Nothing here needs a login:
 * WorkSafeBC's *clearance letter* service does — it identifies the requester and
 * issues an addressed letter — and is deliberately not exposed.
 */
export default defineToolkit({
  id: 'worksafebc-cor',
  name: 'WorkSafeBC COR Registry',
  description:
    "Look up an employer's WorkSafeBC Certificate of Recognition (COR) — search by legal or trade name, read a firm's certificates (certifying partner, COR type, certificate number, expiry date, classification units), and list every employer a certifying partner has certified. No key needed.",
  icon: '🦺',
  version: '1.0.0',
  secrets: [],
  scopes: [],
  visibility: 'public',
  egress: ['corcp.online.worksafebc.com'],
  tools: [searchEmployers, getEmployerCertificates, listCertifyingPartners, listCertifiedEmployers],
});
