import { type ToolDefinition, z } from '@ontrove/mcp';
import {
  BASE_URL,
  fetchEmployerDetails,
  fetchGrid,
  getSession,
  SEARCH_PAGE,
  toEmployerHit,
} from '../corcp.ts';
import { employerShape } from '../shapes.ts';
import { accountNumber, pageNote } from '../text.ts';

/**
 * The shortest name the search endpoint will serve.
 *
 * WorkSafeBC's own form declares a five-character minimum, but the endpoint
 * behind it does not enforce one: four characters return real results
 * (`bell` → 8 matches, `wood` → 45, `ltd.` → 1781), while three 302 to
 * `/Error/Index`. Copying the form's five would make this tool stricter than
 * the service it wraps and refuse queries that work.
 */
const MIN_NAME_LENGTH = 4;

/** Search COR-certified employers by legal or trade name. */
export const searchEmployers: ToolDefinition = {
  name: 'search_employers',
  title: 'WorkSafeBC COR: Search certified employers',
  description:
    "Search WorkSafeBC's Certificate of Recognition registry for employers by legal or trade " +
    'name (minimum 5 characters). Returns the WorkSafeBC employer/account number, legal name ' +
    'and trade name for each match; pass an employerId to get_employer_certificates for the ' +
    'certificates themselves. Only COR-certified employers appear here — a firm absent from ' +
    'this registry may still be registered with WorkSafeBC without holding a COR, so a miss ' +
    'is not evidence the firm is unregistered.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    name: z
      .string()
      .min(MIN_NAME_LENGTH)
      .describe('Employer name or fragment, e.g. "darwin construction" (min 5 characters).'),
    nameType: z
      .enum(['legal', 'trade'])
      .default('legal')
      .describe('Match against the legal name (default) or the trade/operating name.'),
    page: z.number().int().min(1).default(1).describe('Page number (default 1).'),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe('Results per page (1–50, default 25).'),
  }),
  output: z.object({
    total: z.number(),
    count: z.number(),
    page: z.number(),
    employers: z.array(z.object(employerShape)),
  }),
  async handler(args, ctx) {
    ctx.log('search_employers', { name: args.name, nameType: args.nameType, page: args.page });
    const session = await getSession(SEARCH_PAGE, ctx);
    const result = await fetchGrid(
      '/Home/GetEmployerSearchResults',
      {
        employerName: args.name,
        employerNameType: args.nameType === 'trade' ? 'TN' : 'LN',
        page: String(args.page),
        pageSize: String(args.pageSize),
        skip: String((args.page - 1) * args.pageSize),
        take: String(args.pageSize),
      },
      session,
      ctx,
    );
    // Exactly one match is answered with a redirect to that employer's page rather than
    // a one-row grid. Its names are fetched from there so the sole hit comes back as a
    // normal result — the alternative is failing the query this tool exists to serve.
    if (result.kind === 'singleMatch') {
      const details = await fetchEmployerDetails(String(result.employerId), ctx);
      const only = {
        employerId: result.employerId,
        accountNumber: accountNumber(result.employerId),
        legalName: details.legalName,
        tradeName: details.tradeName,
        url: `${BASE_URL}/Home/EmployerDetails?employerId=${result.employerId}`,
      };
      return {
        text:
          `1 of 1 COR-certified employer(s) matching "${args.name}":\n` +
          `  ${only.accountNumber} — ${only.legalName ?? '?'}` +
          `${only.tradeName ? ` (trading as ${only.tradeName})` : ''}`,
        structured: { total: 1, count: 1, page: 1, employers: [only] },
      };
    }
    const { rows, total } = result;
    const employers = rows.map(toEmployerHit);
    const structured = { total, count: employers.length, page: args.page, employers };
    if (employers.length === 0) {
      return {
        text:
          `No COR-certified employer matched "${args.name}" by ${args.nameType} name. ` +
          'The firm may be registered with WorkSafeBC but hold no Certificate of Recognition.',
        structured,
      };
    }
    const lines = employers
      .map(
        (e) =>
          `  ${e.accountNumber ?? '?'} — ${e.legalName ?? '?'}` +
          `${e.tradeName ? ` (trading as ${e.tradeName})` : ''}`,
      )
      .join('\n');
    return {
      text:
        `${employers.length} of ${total} COR-certified employer(s) matching "${args.name}":\n` +
        lines +
        pageNote(total, employers.length, args.page, args.pageSize),
      structured,
    };
  },
};
