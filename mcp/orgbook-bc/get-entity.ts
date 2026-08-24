import { tool, z } from '@ontrove/extend/toolkit';
import { entityShape, findByRegistrationNumber, toEntity } from './entities.js';

/** The `get_entity` tool. */
export const getEntityTool = tool({
  name: 'get_entity',
  title: 'OrgBook BC: Get entity by registration number',
  description:
    'Look up one BC registration exactly by its registration number (e.g. BC0112233, ' +
    'FM0445566, S0012345). Returns the legal name, CRA business number, Active/Historical ' +
    'status, entity type, home jurisdiction, registration date, and the OrgBook page URL. ' +
    'The verification step before onboarding or paying a counterparty.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    registrationNumber: z
      .string()
      .min(2)
      .describe('BC registration number, e.g. "BC0112233" or "FM0445566".'),
  }),
  output: z.object(entityShape),
  async handler(args, ctx) {
    ctx.log('get_entity', { registrationNumber: args.registrationNumber });
    const row = await findByRegistrationNumber(args.registrationNumber, ctx);
    const entity = toEntity(row);
    const businessNumber = entity.businessNumber ? ` · BN ${entity.businessNumber}` : '';
    const jurisdiction = entity.homeJurisdiction ? ` in ${entity.homeJurisdiction}` : '';
    const url = entity.url ? `\n  ${entity.url}` : '';
    return {
      text:
        `${entity.entityName ?? '?'} (${entity.registrationNumber ?? '?'})\n` +
        `  Status: ${entity.entityStatus ?? '?'} · Type: ${entity.entityType ?? '?'}${businessNumber}\n` +
        `  Registered: ${entity.registrationDate?.slice(0, 10) ?? '?'}${jurisdiction}${url}`,
      structured: entity,
    };
  },
});
