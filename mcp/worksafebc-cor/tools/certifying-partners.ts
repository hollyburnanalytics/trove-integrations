import { type ToolDefinition, ToolError, z } from '@ontrove/mcp';
import {
  fetchGrid,
  getSession,
  PARTNER_PAGE,
  parsePartners,
  toPartnerCertifiedEmployer,
} from '../corcp.ts';
import { partnerCertifiedEmployerShape } from '../shapes.ts';
import { pageNote } from '../text.ts';

/** List the industry safety associations that issue CORs in BC. */
export const listCertifyingPartners: ToolDefinition = {
  name: 'list_certifying_partners',
  title: 'WorkSafeBC COR: List certifying partners',
  description:
    'List the certifying partners that issue Certificates of Recognition in BC (the industry ' +
    'safety associations — BCCSA, BCMSA, Energy Safety Canada, the BC Forest Safety Council ' +
    'and others, including historical ones). Returns each partner id and name; pass an id to ' +
    'list_certified_employers.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({}),
  output: z.object({
    count: z.number(),
    partners: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  async handler(_args, ctx) {
    ctx.log('list_certifying_partners');
    const { html } = await getSession(PARTNER_PAGE, ctx);
    const partners = parsePartners(html);
    if (partners.length === 0) {
      throw new ToolError(
        'The WorkSafeBC COR registry returned no certifying partners; try again.',
        { retryable: true },
      );
    }
    return {
      text:
        `${partners.length} certifying partner(s):\n` +
        partners.map((p) => `  ${p.id} — ${p.name}`).join('\n'),
      structured: { count: partners.length, partners },
    };
  },
};

/** List every employer one certifying partner has certified. */
export const listCertifiedEmployers: ToolDefinition = {
  name: 'list_certified_employers',
  title: 'WorkSafeBC COR: List a partner’s certified employers',
  description:
    'List every employer one certifying partner has issued a Certificate of Recognition to, ' +
    'with the COR type, certificate number, expiry date and classification units on each row. ' +
    'Takes a partner id from list_certifying_partners. Paged — the total says how many that ' +
    'partner has certified in all.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    certifyingPartnerId: z
      .string()
      .min(1)
      .describe('Certifying partner id from list_certifying_partners, e.g. "000810731".'),
    page: z.number().int().min(1).default(1).describe('Page number (default 1).'),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Results per page (1–50, default 20).'),
  }),
  output: z.object({
    total: z.number(),
    count: z.number(),
    page: z.number(),
    employers: z.array(z.object(partnerCertifiedEmployerShape)),
  }),
  async handler(args, ctx) {
    ctx.log('list_certified_employers', {
      certifyingPartnerId: args.certifyingPartnerId,
      page: args.page,
    });
    // This grid's antiforgery pair must come from `/`; a token minted on the
    // employer-search page is rejected here with a 302 to /Error/Index.
    const session = await getSession(PARTNER_PAGE, ctx);
    // An unknown partner id is answered with the *same* 302 to /Error/Index as a stale
    // token — one is the caller's fault and permanent, the other is transient, and the
    // response cannot tell them apart. The landing page just fetched for the token also
    // carries the full partner list, so the id is checked here, for free, before the
    // call is spent. What remains after this check really is likely transient.
    const wanted = args.certifyingPartnerId.trim();
    const partners = parsePartners(session.html);
    if (partners.length > 0 && !partners.some((partner) => partner.id === wanted)) {
      throw new ToolError(
        `"${wanted}" is not a WorkSafeBC certifying partner id. Valid ids: ` +
          `${partners.map((partner) => `${partner.id} (${partner.name})`).join(', ')}.`,
        { retryable: false },
      );
    }
    const result = await fetchGrid(
      '/Home/GetCertifyingPartnerEmployers',
      {
        certifyingPartnerEmployerId: wanted,
        page: String(args.page),
        pageSize: String(args.pageSize),
        skip: String((args.page - 1) * args.pageSize),
        take: String(args.pageSize),
      },
      session,
      ctx,
    );
    // The single-match redirect is a search-only behaviour; this grid always returns rows.
    if (result.kind !== 'rows') {
      throw new ToolError('The WorkSafeBC COR registry returned an unexpected response.', {
        retryable: true,
      });
    }
    const { rows, total } = result;
    const employers = rows.map(toPartnerCertifiedEmployer);
    const structured = { total, count: employers.length, page: args.page, employers };
    if (employers.length === 0) {
      // The id was checked against the landing page above, so reaching here means a valid
      // partner with nothing listed — which is what the two partners marked (HISTORICAL)
      // return. Telling the caller to re-check the id would send them after a non-problem.
      return {
        text:
          `${wanted} is a valid certifying partner but has no employers listed on this page. ` +
          'Partners marked (HISTORICAL) no longer certify and return nothing.',
        structured,
      };
    }
    const lines = employers
      .map(
        (e) =>
          `  ${e.accountNumber ?? '?'} — ${e.legalName ?? '?'} ` +
          `[${e.corType ?? 'COR'} · expires ${e.expiryDate ?? '?'}` +
          `${e.expired === true ? ' · EXPIRED' : ''}]`,
      )
      .join('\n');
    return {
      text:
        `${employers.length} of ${total} employer(s) certified by ${args.certifyingPartnerId}:\n` +
        lines +
        pageNote(total, employers.length, args.page, args.pageSize),
      structured,
    };
  },
};
