import { ToolError, tool, z } from '@ontrove/extend/toolkit';
import { BASE_URL, findByRegistrationNumber, parseCredentialSets, toEntity } from './entities.js';

/** The `get_entity_history` tool. */
export const getEntityHistoryTool = tool({
  name: 'get_entity_history',
  title: 'OrgBook BC: Get entity history',
  description:
    'Read the credential timeline behind one BC registration — every registration/name/' +
    'business-number credential with its effective date and whether it was superseded ' +
    '(revoked) by a later filing. Shows name changes and status transitions over time; ' +
    "useful when a vendor's current name doesn't match older paperwork.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    registrationNumber: z.string().min(2).describe('BC registration number, e.g. "BC0112233".'),
  }),
  output: z.object({
    registrationNumber: z.string().nullable(),
    entityName: z.string().nullable(),
    count: z.number(),
    credentials: z.array(
      z.object({
        type: z.string().nullable(),
        effectiveDate: z.string().nullable(),
        latest: z.boolean().nullable(),
        revoked: z.boolean().nullable(),
        revokedDate: z.string().nullable(),
        names: z.array(z.object({ text: z.string(), type: z.string().nullable() })),
        attributes: z.array(z.object({ type: z.string(), value: z.string() })),
      }),
    ),
  }),
  async handler(args, ctx) {
    ctx.log('get_entity_history', { registrationNumber: args.registrationNumber });
    const row = await findByRegistrationNumber(args.registrationNumber, ctx);
    const entity = toEntity(row);
    if (entity.topicId === null) {
      throw new ToolError('OrgBook returned a registration without a topic id; try again.', {
        retryable: true,
      });
    }
    const body = (await ctx.fetchJson(`${BASE_URL}/api/v4/topic/${entity.topicId}/credential-set`, {
      errorMap: (res, text) =>
        new ToolError(
          res.status === 404
            ? `No credential history for ${entity.registrationNumber}.`
            : `OrgBook BC returned ${res.status}: ${text.slice(0, 100)}`,
          { retryable: res.status === 429 || res.status >= 500 },
        ),
    })) as unknown;
    const credentials = parseCredentialSets(body);
    const structured = {
      registrationNumber: entity.registrationNumber,
      entityName: entity.entityName,
      count: credentials.length,
      credentials,
    };
    if (credentials.length === 0) {
      return {
        text: `No credential history for ${entity.registrationNumber ?? '?'}.`,
        structured,
      };
    }
    const lines = credentials
      .map((c) => {
        const name = c.names.map((n) => n.text).join(', ');
        const named = name ? ` — ${name}` : '';
        const superseded = c.revoked ? ' (superseded)' : '';
        return `  ${c.effectiveDate?.slice(0, 10) ?? '?'} ${c.type ?? 'Credential'}${named}${superseded}`;
      })
      .join('\n');
    return {
      text:
        `${credentials.length} credential(s) for ${entity.entityName ?? '?'} ` +
        `(${entity.registrationNumber ?? '?'}):\n${lines}`,
      structured,
    };
  },
});
