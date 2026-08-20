import { tool, z } from '@ontrove/extend/toolkit';
import { PROGRAMS } from '../programs.ts';

/**
 * `list_programs` — the mileage-program catalogue, answered locally.
 *
 * It spends no API call, which matters: a Pro key gets 1,000 a day, and the two
 * things this returns (the exact `source` slug, and whether a program publishes
 * seat counts and taxes) are otherwise learned by burning calls on searches that
 * come back empty or with zeros that mean nothing.
 */
export const listPrograms = tool({
  name: 'list_programs',
  title: 'Seats.aero: List mileage programs',
  description:
    `List the ${PROGRAMS.length} mileage programs Seats.aero indexes, with the exact \`source\` slug each ` +
    'search takes, the cabins it covers, and whether it publishes seat counts and taxes. ' +
    'Answered locally — costs no API call and no daily quota. Call this before filtering a ' +
    'search by program: an unrecognised slug returns an empty result rather than an error.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    cabin: z
      .enum(['economy', 'premium', 'business', 'first'])
      .optional()
      .describe('Only list programs searchable in this cabin.'),
  }),
  output: z.object({
    count: z.number(),
    programs: z.array(
      z.object({
        source: z.string(),
        name: z.string(),
        cabins: z.array(z.string()),
        seatCounts: z.enum(['yes', 'partial', 'no']),
        taxes: z.boolean(),
      }),
    ),
  }),
  // Answered from the local table above — no egress, hence no await.
  async handler(args, _ctx) {
    const programs = PROGRAMS.filter((p) => !args.cabin || p.cabins.includes(args.cabin));
    const lines = programs.map((p) => {
      const seats =
        p.seatCounts === 'yes'
          ? 'seat counts'
          : p.seatCounts === 'partial'
            ? 'seat counts only when low'
            : 'NO seat counts';
      return `  ${p.source.padEnd(15)} ${p.name.padEnd(28)} ${p.cabins.join('/')} · ${seats}${
        p.taxes ? '' : ' · NO taxes/surcharges'
      }`;
    });
    return {
      text: [
        `${programs.length} mileage program(s)${args.cabin ? ` searchable in ${args.cabin}` : ''}:`,
        ...lines,
        '',
        'Where a program does not publish seat counts or taxes, a zero in a result is missing data — not "none left" or "no taxes".',
      ].join('\n'),
      structured: {
        count: programs.length,
        programs: programs.map((p) => ({ ...p, cabins: [...p.cabins] })),
      },
    };
  },
});
