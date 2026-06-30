import { describe, expect, it } from 'bun:test';
import { callTool } from '../lib/test-harness.mjs';
import server from './server.ts';

const SEARCH_BODY = {
  response: {
    docs: [
      {
        identifier: 'TheGreatTrainRobbery',
        title: 'The Great Train Robbery',
        creator: ['Edwin S. Porter', 'Edison Manufacturing Company'],
        year: '1903',
        mediatype: 'movies',
      },
      {
        identifier: 'aroundworldin80da00vern',
        title: 'Around the World in Eighty Days',
        creator: 'Jules Verne',
        year: 1873,
        mediatype: 'texts',
      },
    ],
  },
};

const METADATA_BODY = {
  metadata: {
    title: 'The Great Train Robbery',
    creator: ['Edwin S. Porter'],
    year: '1903',
    date: '1903-12-01',
    description: ['A landmark early narrative film.', 'Public domain.'],
    mediatype: 'movies',
  },
  files: [
    { name: 'great_train_robbery.mp4', format: 'h.264', size: '12345' },
    { name: 'great_train_robbery.ogv', format: 'Ogg Video', size: '23456' },
    { name: '__ia_thumb.jpg', format: 'Item Tile', size: '999' },
    { name: 'metadata.json', format: 'Metadata', size: '111' },
  ],
};

describe('internet-archive MCP server', () => {
  it('lists the two tools', () => {
    expect(server.tools.map((t) => t.name).toSorted()).toEqual(['get_item', 'search_archive']);
  });

  describe('search_archive', () => {
    it('returns normalized results for a query', async () => {
      const result = await callTool(
        server,
        'search_archive',
        { query: 'jules verne' },
        {
          json: SEARCH_BODY,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(2);
      expect(result.result.structured.page).toBe(1);
      const [first, second] = result.result.structured.results;
      expect(first.identifier).toBe('TheGreatTrainRobbery');
      expect(first.creator).toBe('Edwin S. Porter, Edison Manufacturing Company');
      expect(first.year).toBe('1903');
      expect(first.itemUrl).toBe('https://archive.org/details/TheGreatTrainRobbery');
      // year normalized from a number
      expect(second.year).toBe('1873');
      expect(second.creator).toBe('Jules Verne');
      expect(result.result.text).toContain('The Great Train Robbery');
    });

    it('applies the mediatype filter to the query string', async () => {
      let requested = '';
      await callTool(server, 'search_archive', { query: 'trains', mediatype: 'movies' }, (url) => {
        requested = url;
        return { json: SEARCH_BODY };
      });
      expect(requested).toContain('archive.org/advancedsearch.php');
      // URLSearchParams encodes spaces as '+' and ':' as '%3A'.
      expect(requested).toContain('q=trains+AND+mediatype%3Amovies');
    });

    it('passes rows and page through to the request', async () => {
      let requested = '';
      await callTool(server, 'search_archive', { query: 'moon', rows: 25, page: 3 }, (url) => {
        requested = url;
        return { json: SEARCH_BODY };
      });
      expect(requested).toContain('rows=25');
      expect(requested).toContain('page=3');
    });

    it('reports an empty result set cleanly', async () => {
      const result = await callTool(
        server,
        'search_archive',
        { query: 'zzzznothing' },
        {
          json: { response: { docs: [] } },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.count).toBe(0);
      expect(result.result.structured.results).toEqual([]);
      expect(result.result.text).toMatch(/no internet archive items found/i);
    });

    it('maps a 400 to a non-retryable error', async () => {
      const result = await callTool(
        server,
        'search_archive',
        { query: 'bad query' },
        { status: 400 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/rejected the search query/i);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'search_archive',
        { query: 'anything' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty query before fetching', async () => {
      const result = await callTool(server, 'search_archive', { query: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects rows above the maximum before fetching', async () => {
      const result = await callTool(server, 'search_archive', { query: 'ok', rows: 51 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects an unknown mediatype before fetching', async () => {
      const result = await callTool(server, 'search_archive', { query: 'ok', mediatype: 'book' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });

  describe('get_item', () => {
    it('returns item metadata and notable files', async () => {
      const result = await callTool(
        server,
        'get_item',
        { identifier: 'TheGreatTrainRobbery' },
        {
          json: METADATA_BODY,
        },
      );
      expect(result.ok).toBe(true);
      const s = result.result.structured;
      expect(s.identifier).toBe('TheGreatTrainRobbery');
      expect(s.title).toBe('The Great Train Robbery');
      expect(s.creator).toBe('Edwin S. Porter');
      expect(s.year).toBe('1903');
      expect(s.mediatype).toBe('movies');
      expect(s.description).toBe('A landmark early narrative film., Public domain.');
      expect(s.itemUrl).toBe('https://archive.org/details/TheGreatTrainRobbery');
      // Bookkeeping files (Item Tile, Metadata) are filtered out.
      expect(s.files.map((f) => f.name)).toEqual([
        'great_train_robbery.mp4',
        'great_train_robbery.ogv',
      ]);
      expect(s.files[0].downloadUrl).toBe(
        'https://archive.org/download/TheGreatTrainRobbery/great_train_robbery.mp4',
      );
      expect(result.result.text).toContain('Files:');
    });

    it('honors the maxFiles limit', async () => {
      const result = await callTool(
        server,
        'get_item',
        {
          identifier: 'TheGreatTrainRobbery',
          maxFiles: 1,
        },
        { json: METADATA_BODY },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.files).toHaveLength(1);
      expect(result.result.structured.files[0].name).toBe('great_train_robbery.mp4');
    });

    it('falls back to date when year is absent and percent-encodes file path segments', async () => {
      const result = await callTool(
        server,
        'get_item',
        { identifier: 'some item/id' },
        {
          json: {
            metadata: { title: 'X', date: '1955-06-01', mediatype: 'texts' },
            files: [{ name: 'a b/c d.txt', format: 'Text' }],
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(result.result.structured.year).toBe('1955');
      expect(result.result.structured.files[0].downloadUrl).toBe(
        'https://archive.org/download/some item/id/a%20b/c%20d.txt',
      );
    });

    it('treats an empty metadata response as a not-found error', async () => {
      const result = await callTool(
        server,
        'get_item',
        { identifier: 'does-not-exist' },
        {
          json: { files: [] },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no internet archive item found/i);
    });

    it('maps a 404 to a non-retryable error', async () => {
      const result = await callTool(server, 'get_item', { identifier: 'missing' }, { status: 404 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(false);
      expect(result.error).toMatch(/no internet archive item found/i);
    });

    it('maps a 500 to a retryable error', async () => {
      const result = await callTool(
        server,
        'get_item',
        { identifier: 'whatever' },
        { status: 500 },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.retryable).toBe(true);
    });

    it('rejects an empty identifier before fetching', async () => {
      const result = await callTool(server, 'get_item', { identifier: '' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });

    it('rejects maxFiles above the maximum before fetching', async () => {
      const result = await callTool(server, 'get_item', { identifier: 'ok', maxFiles: 26 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_PARAMS');
    });
  });
});
