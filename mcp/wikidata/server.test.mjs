import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const SEARCH_BODY = {
  search: [
    {
      id: 'Q1430',
      label: 'Marcus Aurelius',
      description: 'Roman emperor and Stoic philosopher (121–180)',
    },
    { id: 'Q2', label: 'Earth', description: '' },
  ],
};

// Entity fetch: props=labels|descriptions|aliases|claims (URL-encoded "descriptions").
const ENTITY_BODY = {
  entities: {
    Q1430: {
      id: 'Q1430',
      labels: { en: { value: 'Marcus Aurelius' } },
      descriptions: { en: { value: 'Roman emperor and Stoic philosopher' } },
      aliases: { en: [{ value: 'Marcus Annius Verus' }, { value: 'Aurelius' }] },
      claims: {
        P31: [
          {
            mainsnak: {
              snaktype: 'value',
              datavalue: { type: 'wikibase-entityid', value: { id: 'Q5' } },
            },
          },
        ],
        P569: [
          {
            mainsnak: {
              snaktype: 'value',
              datavalue: {
                type: 'time',
                value: { time: '+0121-04-26T00:00:00Z', precision: 11 },
              },
            },
          },
        ],
      },
    },
  },
};

// Label resolution call: props=labels only (no "descriptions" in the URL).
const LABELS_BODY = {
  entities: {
    P31: { labels: { en: { value: 'instance of' } } },
    P569: { labels: { en: { value: 'date of birth' } } },
    Q5: { labels: { en: { value: 'human' } } },
  },
};

/** Route the entity fetch vs. the label-resolution fetch by URL shape. */
function entityResponder(url) {
  if (url.includes('descriptions')) return { json: ENTITY_BODY };
  return { json: LABELS_BODY };
}

describe('wikidata MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_entity', 'search_entities']);
  });

  describe('search_entities', () => {
    it('returns matched entities with id, label, and description', async () => {
      const result = await callTool(
        server,
        'search_entities',
        { query: 'Marcus Aurelius' },
        { json: SEARCH_BODY },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.query).toBe('Marcus Aurelius');
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.entities[0]).toEqual({
        id: 'Q1430',
        label: 'Marcus Aurelius',
        description: 'Roman emperor and Stoic philosopher (121–180)',
      });
      // Empty description string normalizes to null.
      expect(result.result.structured.entities[1].description).toBeNull();
      expect(result.result.text).toContain('[Q1430] Marcus Aurelius');
    });

    it('sends the query and limit through to the API', async () => {
      let requested = '';
      await callTool(server, 'search_entities', { query: 'Earth', limit: 5 }, (url) => {
        requested = url;
        return { json: SEARCH_BODY };
      });
      expect(requested).toContain('action=wbsearchentities');
      expect(requested).toContain('search=Earth');
      expect(requested).toContain('limit=5');
    });

    it('reports no matches cleanly', async () => {
      const result = await callTool(
        server,
        'search_entities',
        { query: 'zzzznotathing' },
        { json: { search: [] } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no wikidata entities/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(server, 'search_entities', { query: 'x' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/wikidata returned 500/i);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(server, 'search_entities', { query: 'x' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects an out-of-range limit before fetching', async () => {
      const result = await callTool(server, 'search_entities', { query: 'x', limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_entities', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_entity', () => {
    it('returns label, description, aliases, and resolved facts', async () => {
      const result = await callTool(server, 'get_entity', { id: 'Q1430' }, entityResponder);
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.id).toBe('Q1430');
      expect(s.label).toBe('Marcus Aurelius');
      expect(s.description).toBe('Roman emperor and Stoic philosopher');
      expect(s.aliases).toEqual(['Marcus Annius Verus', 'Aurelius']);
      expect(s.url).toBe('https://www.wikidata.org/wiki/Q1430');
      // Property ids resolved to labels; entity-valued target Q5 resolved to "human".
      expect(s.facts).toContainEqual({ property: 'instance of', values: ['human'] });
      // Time value formatted from the mainsnak.
      expect(s.facts).toContainEqual({ property: 'date of birth', values: ['121-04-26'] });
      expect(result.result.text).toContain('[Q1430] Marcus Aurelius');
    });

    it('uppercases a lowercase id in the request and URL', async () => {
      let entityUrl = '';
      const result = await callTool(server, 'get_entity', { id: 'q1430' }, (url) => {
        if (url.includes('descriptions')) {
          entityUrl = url;
          return { json: ENTITY_BODY };
        }
        return { json: LABELS_BODY };
      });
      expect(result.ok).toBe(true);
      expect(entityUrl).toContain('ids=Q1430');
      expect(result.result.structured.url).toContain('/wiki/Q1430');
    });

    it('throws a non-retryable error for a missing entity', async () => {
      const result = await callTool(
        server,
        'get_entity',
        { id: 'Q999999999' },
        { json: { entities: { Q999999999: { missing: '' } } } },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no wikidata entity/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(server, 'get_entity', { id: 'Q1430' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a malformed id before fetching', async () => {
      const result = await callTool(server, 'get_entity', { id: 'not-a-qid' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
