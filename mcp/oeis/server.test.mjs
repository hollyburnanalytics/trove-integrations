import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const FIB = {
  number: 45,
  name: 'Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.',
  data: '0,1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987',
  formula: ['F(n) = ((1+sqrt(5))/2)^n / sqrt(5), rounded.', 'a(n) = a(n-1) + a(n-2).'],
  comment: [
    'Also the Lucas sequence U(1, -1).',
    'D. E. Knuth notes this is the canonical example.',
  ],
  example: ['a(5) = 5.', 'a(6) = 8.'],
  keyword: 'nonn,core,nice,easy',
  author: '_N. J. A. Sloane_',
};

const CATALAN = {
  number: 108,
  name: 'Catalan numbers: C(n) = binomial(2n,n)/(n+1).',
  data: '1,1,2,5,14,42,132,429,1430',
  keyword: 'nonn,core,nice',
};

describe('oeis MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual([
      'get_sequence',
      'search_sequences',
    ]);
  });

  describe('search_sequences', () => {
    it('returns matching sequences with A-numbers and terms', async () => {
      const result = await callTool(
        server,
        'search_sequences',
        { query: '1, 1, 2, 3, 5, 8' },
        { json: [FIB, CATALAN] },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.query).toBe('1, 1, 2, 3, 5, 8');
      expect(result.result.structured.sequences[0].id).toBe('A000045');
      expect(result.result.structured.sequences[0].terms).toContain('0,1,1,2,3,5,8');
      expect(result.result.structured.sequences[0].keywords).toBe('nonn,core,nice,easy');
      expect(result.result.structured.sequences[1].id).toBe('A000108');
      expect(result.result.text).toContain('A000045');
    });

    it('requests the OEIS search endpoint with json format', async () => {
      let requested = '';
      await callTool(server, 'search_sequences', { query: 'Catalan numbers' }, (url) => {
        requested = url;
        return { json: [CATALAN] };
      });
      expect(requested).toContain('https://oeis.org/search?');
      expect(requested).toContain('fmt=json');
      expect(requested).toContain('q=Catalan');
    });

    it('honours the limit by slicing results', async () => {
      const result = await callTool(
        server,
        'search_sequences',
        { query: 'numbers', limit: 1 },
        { json: [FIB, CATALAN] },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(1);
      expect(result.result.structured.sequences).toHaveLength(1);
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_sequences',
        { query: 'zzzznomatch' },
        { json: [] },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.text).toMatch(/no oeis sequences matched/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_sequences',
        { query: 'fib' },
        { status: 500, text: 'boom' },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 429 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_sequences',
        { query: 'fib' },
        { status: 429, text: 'slow down' },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('maps a 400 to a non-retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'search_sequences',
        { query: 'fib' },
        { status: 400, text: 'bad' },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
    });

    it('rejects a limit above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_sequences', { query: 'fib', limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_sequences', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_sequence', () => {
    it('returns one sequence with formulas, comments, and examples', async () => {
      const result = await callTool(server, 'get_sequence', { id: 'A000045' }, { json: [FIB] });
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.id).toBe('A000045');
      expect(s.name).toContain('Fibonacci');
      expect(s.terms).toContain('0,1,1,2,3,5,8');
      expect(s.formula).toContain('a(n) = a(n-1) + a(n-2).');
      expect(s.comments).toContain('Lucas sequence');
      expect(s.example).toContain('a(5) = 5.');
      expect(s.keywords).toBe('nonn,core,nice,easy');
      expect(s.author).toBe('_N. J. A. Sloane_');
      expect(s.url).toBe('https://oeis.org/A000045');
      expect(result.result.text).toContain('A000045');
    });

    it('normalizes a bare numeric id to canonical A-number in the request', async () => {
      let requested = '';
      await callTool(server, 'get_sequence', { id: '45' }, (url) => {
        requested = url;
        return { json: [FIB] };
      });
      expect(requested).toContain('id%3AA000045');
    });

    it('throws a non-retryable TOOL_ERROR when no record is returned', async () => {
      const result = await callTool(server, 'get_sequence', { id: 'A999999' }, { json: [] });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no oeis sequence/i);
    });

    it('maps a 500 to a retryable TOOL_ERROR', async () => {
      const result = await callTool(
        server,
        'get_sequence',
        { id: 'A000045' },
        { status: 500, text: 'boom' },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty id before fetching', async () => {
      const result = await callTool(server, 'get_sequence', { id: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
