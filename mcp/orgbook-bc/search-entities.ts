import { tool, z } from '@ontrove/extend/toolkit';
import { entityLine, entityShape, searchTopics, toEntity } from './entities.js';

/** The `search_entities` tool. */
export const searchEntitiesTool = tool({
  name: 'search_entities',
  title: 'OrgBook BC: Search entities',
  description:
    'Search BC-registered legal entities by name in the public corporate registry. Returns ' +
    'registration number, legal name, CRA business number, Active/Historical status, entity ' +
    'type, and registration date, relevance-ranked. Multi-word queries match any word, so ' +
    'the total can be large — the top hits are what matter. Good for "is this counterparty ' +
    'actually registered, and under what exact legal name?".',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().min(1).describe('Entity name or keywords, e.g. "coastal formworks".'),
    page: z.number().int().min(1).default(1).describe('Page number (default 1).'),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Results per page (1–50, default 10).'),
  }),
  output: z.object({
    total: z.number(),
    count: z.number(),
    entities: z.array(z.object(entityShape)),
  }),
  async handler(args, ctx) {
    ctx.log('search_entities', { query: args.query, page: args.page });
    const { total, rows } = await searchTopics(args.query, args.page, args.pageSize, ctx);
    const entities = rows.map(toEntity);
    if (entities.length === 0) {
      return {
        text: `No BC registrations matched "${args.query}".`,
        structured: { total: 0, count: 0, entities: [] },
      };
    }
    return {
      text:
        `${entities.length} of ${total} BC registration(s) for "${args.query}":\n` +
        entities.map(entityLine).join('\n'),
      structured: { total, count: entities.length, entities },
    };
  },
});
