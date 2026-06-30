import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

// A realistic open-access object record, shaped from the fields toArtwork() reads.
const VAN_GOGH = {
  objectID: 436_524,
  title: 'Wheat Field with Cypresses',
  artistDisplayName: 'Vincent van Gogh',
  artistDisplayBio: 'Dutch, Zundert 1853–1890 Auvers-sur-Oise',
  objectDate: '1889',
  medium: 'Oil on canvas',
  dimensions: '28 7/8 × 36 3/4 in. (73.2 × 93.4 cm)',
  culture: '',
  period: '',
  department: 'European Paintings',
  classification: 'Paintings',
  creditLine: 'Purchase, The Annenberg Foundation Gift, 1993',
  isPublicDomain: true,
  primaryImage: 'https://images.metmuseum.org/CRDImages/ep/original/DT1567.jpg',
  objectURL: 'https://www.metmuseum.org/art/collection/search/436524',
};

// Branch a search request: the /search endpoint vs the per-object detail endpoint.
function searchResponder({ ids, total, objects }) {
  return (url) => {
    if (url.includes('/search?')) {
      return { json: { total: total ?? ids.length, objectIDs: ids } };
    }
    const match = url.match(/\/objects\/(\d+)/);
    const id = match ? Number(match[1]) : 0;
    const object = objects.get(id);
    if (!object) return { status: 404 };
    return { json: object };
  };
}

describe('the-met MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_object', 'search_objects']);
  });

  describe('search_objects', () => {
    it('searches and resolves the top hits to artworks', async () => {
      const result = await callTool(
        server,
        'search_objects',
        { query: 'van gogh' },
        searchResponder({ ids: [436_524], total: 12, objects: new Map([[436_524, VAN_GOGH]]) }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.query).toBe('van gogh');
      expect(result.result.structured.total).toBe(12);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.objects[0].objectId).toBe(436_524);
      expect(result.result.structured.objects[0].artist).toBe('Vincent van Gogh');
      expect(result.result.structured.objects[0].isPublicDomain).toBe(true);
      expect(result.result.text).toContain('Wheat Field with Cypresses');
    });

    it('sets hasImages=true in the query by default', async () => {
      let searchUrl = '';
      await callTool(server, 'search_objects', { query: 'cats' }, (url) => {
        if (url.includes('/search?')) {
          searchUrl = url;
          return { json: { total: 0, objectIDs: [] } };
        }
        return { status: 404 };
      });
      expect(searchUrl).toContain('hasImages=true');
      expect(searchUrl).toContain('q=cats');
    });

    it('respects the limit by only resolving that many ids', async () => {
      const ids = [1, 2, 3, 4, 5];
      const objects = Object.fromEntries(
        ids.map((id) => [id, { ...VAN_GOGH, objectID: id, title: `Art ${id}` }]),
      );
      const resolved = new Set();
      const result = await callTool(server, 'search_objects', { query: 'all', limit: 2 }, (url) => {
        if (url.includes('/search?')) return { json: { total: 5, objectIDs: ids } };
        const id = Number(url.match(/\/objects\/(\d+)/)[1]);
        resolved.add(id);
        return { json: objects[id] };
      });
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(resolved.size).toBe(2);
    });

    it('returns an empty result cleanly when nothing matches', async () => {
      const result = await callTool(
        server,
        'search_objects',
        { query: 'zzzznomatch' },
        searchResponder({ ids: [], total: 0, objects: new Map() }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.total).toBe(0);
      expect(result.result.text).toMatch(/no met artworks matched/i);
    });

    it('drops individual objects that fail to resolve', async () => {
      const result = await callTool(
        server,
        'search_objects',
        { query: 'partial' },
        searchResponder({
          ids: [436_524, 999_999],
          total: 2,
          objects: new Map([[436_524, VAN_GOGH]]),
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.objects[0].objectId).toBe(436_524);
    });

    it('maps a 500 on the search endpoint to a retryable error', async () => {
      const result = await callTool(server, 'search_objects', { query: 'boom' }, (url) =>
        url.includes('/search?') ? { status: 500 } : { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 429 on the search endpoint to a retryable error', async () => {
      const result = await callTool(server, 'search_objects', { query: 'rate' }, (url) =>
        url.includes('/search?') ? { status: 429 } : { status: 404 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an over-limit argument before fetching', async () => {
      const result = await callTool(server, 'search_objects', { query: 'x', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_objects', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_object', () => {
    it('returns full details for one object', async () => {
      const result = await callTool(
        server,
        'get_object',
        { objectId: 436_524 },
        { json: VAN_GOGH },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.objectId).toBe(436_524);
      expect(s.title).toBe('Wheat Field with Cypresses');
      expect(s.artist).toBe('Vincent van Gogh');
      expect(s.artistBio).toBe('Dutch, Zundert 1853–1890 Auvers-sur-Oise');
      expect(s.dimensions).toContain('cm');
      expect(s.creditLine).toContain('Annenberg');
      expect(s.isPublicDomain).toBe(true);
      expect(result.result.text).toContain('European Paintings');
    });

    it('coerces missing optional fields to null', async () => {
      const result = await callTool(
        server,
        'get_object',
        { objectId: 1 },
        { json: { objectID: 1, title: '', isPublicDomain: false } },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.title).toBe('Untitled');
      expect(s.artist).toBeNull();
      expect(s.culture).toBeNull();
      expect(s.image).toBeNull();
      expect(s.isPublicDomain).toBe(false);
    });

    it('throws a non-retryable error when the object has no objectID', async () => {
      const result = await callTool(
        server,
        'get_object',
        { objectId: 123 },
        { json: { message: 'Not a valid object' } },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no met object/i);
    });

    it('maps a 404 to a non-retryable error', async () => {
      const result = await callTool(server, 'get_object', { objectId: 999_999 }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(server, 'get_object', { objectId: 436_524 }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a non-positive objectId before fetching', async () => {
      const result = await callTool(server, 'get_object', { objectId: -5 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects a non-integer objectId before fetching', async () => {
      const result = await callTool(server, 'get_object', { objectId: 1.5 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
