import { ToolError, tool, z } from '@ontrove/mcp';
import { BASE_URL, fetchEmployerDetails } from '../corcp.ts';
import { type Certificate, certificateShape } from '../shapes.ts';
import { accountNumber } from '../text.ts';

/** One text line describing a certificate's status. */
const certificateLine = (c: Certificate): string =>
  `  ${c.corType ?? 'COR'} · ${c.certifyingPartner ?? '?'} · ${c.certificateNumber ?? '?'} — ` +
  `expires ${c.expiryDate ?? '?'}${c.expired === true ? ' (EXPIRED)' : ''}`;

/** Read one employer's certificates and the classification units they cover. */
export const getEmployerCertificates = tool({
  name: 'get_employer_certificates',
  title: 'WorkSafeBC COR: Get an employer’s certificates',
  description:
    "Read one employer's Certificate of Recognition record by WorkSafeBC employer/account " +
    "number: each certificate's certifying partner (BCCSA, BCMSA, Energy Safety Canada, …), " +
    'COR type, certificate number, expiry date, and the classification units it covers. ' +
    'Expiry is compared against today, so a lapsed certificate is reported as expired rather ' +
    'than returned as though it were current — the check before letting a subcontractor onto ' +
    'a site.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    employerId: z
      .string()
      .min(1)
      .describe('WorkSafeBC employer/account number, e.g. "758078" or "000758078".'),
  }),
  output: z.object({
    employerId: z.number(),
    accountNumber: z.string(),
    legalName: z.string().nullable(),
    tradeName: z.string().nullable(),
    url: z.string(),
    count: z.number(),
    certificates: z.array(z.object(certificateShape)),
  }),
  async handler(args, ctx) {
    const digits = args.employerId.trim().replace(/^0+/, '');
    if (!/^\d+$/.test(digits)) {
      throw new ToolError(
        `"${args.employerId}" is not a WorkSafeBC employer number — they are numeric ` +
          '(6 or 9 digits, e.g. 758078). Use search_employers to find one by name.',
        { retryable: false },
      );
    }
    ctx.log('get_employer_certificates', { employerId: digits });
    const details = await fetchEmployerDetails(digits, ctx);
    const url = `${BASE_URL}/Home/EmployerDetails?employerId=${digits}`;
    const structured = {
      employerId: Number(digits),
      accountNumber: accountNumber(Number(digits)),
      legalName: details.legalName,
      tradeName: details.tradeName,
      url,
      count: details.certificates.length,
      certificates: details.certificates,
    };
    const header =
      `${details.legalName ?? '?'} (${structured.accountNumber})` +
      `${details.tradeName ? ` — trading as ${details.tradeName}` : ''}`;
    if (details.certificates.length === 0) {
      return {
        text: `${header}\n  No Certificate of Recognition on file.\n  ${url}`,
        structured,
      };
    }
    return {
      text: `${header}\n${details.certificates.map(certificateLine).join('\n')}\n  ${url}`,
      structured,
    };
  },
});
