import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const PROPERTY_BODY = {
  PropertyTable: {
    Properties: [
      {
        CID: 2244,
        MolecularFormula: 'C9H8O4',
        MolecularWeight: '180.16',
        IUPACName: '2-acetyloxybenzoic acid',
        CanonicalSMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O',
        InChIKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        XLogP: 1.2,
        TPSA: 63.6,
      },
    ],
  },
};

const DESCRIPTION_BODY = {
  InformationList: {
    Information: [
      { CID: 2244 },
      {
        CID: 2244,
        Description: 'Aspirin is a salicylate used to reduce pain, fever, and inflammation.',
      },
    ],
  },
};

/** Responder that serves the property request and the follow-up description request. */
function compoundResponder({ property, description } = {}) {
  return (url) => {
    if (url.includes('/description/')) return description ?? { json: DESCRIPTION_BODY };
    return property ?? { json: PROPERTY_BODY };
  };
}

describe('pubchem MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_compound',
      'search_compounds',
    ]);
  });

  describe('get_compound', () => {
    it('resolves a compound name to identity and properties', async () => {
      const result = await callTool(
        server,
        'get_compound',
        { name: 'aspirin' },
        compoundResponder(),
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.name).toBe('aspirin');
      expect(s.cid).toBe(2244);
      expect(s.formula).toBe('C9H8O4');
      expect(s.weight).toBe(180.16);
      expect(s.iupacName).toBe('2-acetyloxybenzoic acid');
      expect(s.smiles).toBe('CC(=O)OC1=CC=CC=C1C(=O)O');
      expect(s.inchiKey).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
      expect(s.xlogp).toBe(1.2);
      expect(s.tpsa).toBe(63.6);
      expect(s.description).toMatch(/salicylate/);
      expect(s.url).toBe('https://pubchem.ncbi.nlm.nih.gov/compound/2244');
      expect(result.result.text).toContain('CID 2244');
      expect(result.result.text).toContain('C9H8O4');
    });

    it('url-encodes the compound name in the request path', async () => {
      let propertyUrl = '';
      await callTool(server, 'get_compound', { name: 'acetic acid' }, (url) => {
        if (url.includes('/description/')) return { json: DESCRIPTION_BODY };
        propertyUrl = url;
        return { json: PROPERTY_BODY };
      });
      expect(propertyUrl).toContain('/name/acetic%20acid/');
    });

    it('still succeeds when the description lookup fails (nice-to-have)', async () => {
      const result = await callTool(
        server,
        'get_compound',
        { name: 'aspirin' },
        compoundResponder({ description: { status: 500 } }),
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.cid).toBe(2244);
      expect(result.result.structured.description).toBeNull();
    });

    it('errors (non-retryable) when no property record is returned', async () => {
      const result = await callTool(
        server,
        'get_compound',
        { name: 'notathing' },
        compoundResponder({ property: { json: { PropertyTable: { Properties: [] } } } }),
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/No PubChem compound named/i);
    });

    it('maps a 404 to a non-retryable tool error', async () => {
      const result = await callTool(server, 'get_compound', { name: 'aspirin' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/No PubChem record matched/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(server, 'get_compound', { name: 'aspirin' }, { status: 500 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty name before fetching', async () => {
      const result = await callTool(server, 'get_compound', { name: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('search_compounds', () => {
    const AUTOCOMPLETE_BODY = {
      dictionary_terms: { compound: ['aspirin', 'aspirin sodium', 'aspirin calcium'] },
    };

    it('returns autocomplete suggestions', async () => {
      const result = await callTool(
        server,
        'search_compounds',
        { query: 'aspir' },
        { json: AUTOCOMPLETE_BODY },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.query).toBe('aspir');
      expect(result.result.structured.count).toBe(3);
      expect(result.result.structured.names).toEqual([
        'aspirin',
        'aspirin sodium',
        'aspirin calcium',
      ]);
      expect(result.result.text).toContain('aspirin sodium');
    });

    it('honors the limit by slicing results', async () => {
      const result = await callTool(
        server,
        'search_compounds',
        { query: 'aspir', limit: 2 },
        { json: AUTOCOMPLETE_BODY },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.names).toEqual(['aspirin', 'aspirin sodium']);
    });

    it('passes the limit in the request query string', async () => {
      let requested = '';
      await callTool(server, 'search_compounds', { query: 'caf', limit: 5 }, (url) => {
        requested = url;
        return { json: { dictionary_terms: { compound: [] } } };
      });
      expect(requested).toContain('/autocomplete/compound/caf/JSON?limit=5');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_compounds',
        { query: 'zzzzzz' },
        { json: { dictionary_terms: { compound: [] } } },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.names).toEqual([]);
      expect(result.result.text).toMatch(/No compound names matched/i);
    });

    it('maps a 500 to a retryable tool error', async () => {
      const result = await callTool(
        server,
        'search_compounds',
        { query: 'aspir' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_compounds', { query: 'aspir', limit: 100 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
