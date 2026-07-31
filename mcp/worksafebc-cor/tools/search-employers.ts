import { type ToolDefinition, z } from '@ontrove/mcp';
import { fetchGrid, getSession, SEARCH_PAGE, toEmployerHit } from '../corcp.ts';
import { employerShape } from '../shapes.ts';
import { pageNote } from '../text.ts';

/** WorkSafeBC's minimum for an employer-name search (enforced by the site). */
const MIN_NAME_LENGTH = 5;

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
    const { rows, total } = await fetchGrid(
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
