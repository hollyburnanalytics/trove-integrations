import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { sync } from './index.mjs';

function makeContext() {
  return {
    log: { info: mock(), warn: mock() },
    progress: mock(),
    config: {},
    cursor: undefined,
  };
}

const HN_RESPONSE = {
  hits: [
    {
      objectID: '123',
      title: 'Test HN Story',
      url: 'https://example.com/story',
      points: 100,
      num_comments: 50,
      author: 'testuser',
      created_at: '2024-01-15T00:00:00.000Z',
      story_text: '',
    },
  ],
};

describe('hacker-news connector', () => {
  beforeEach(() => {
    globalThis.fetch = mock();
  });

  afterEach(() => jest.restoreAllMocks());

  it('fetches and maps HN stories', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(HN_RESPONSE),
    });

    const result = await sync(makeContext());
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].id).toBe('hn-123');
    expect(result.documents[0].title).toBe('Test HN Story');
    expect(result.documents[0].author).toBe('testuser');
    expect(result.documents[0].url).toBe('https://example.com/story');
    expect(result.documents[0].text).toContain('Points: 100');
    expect(result.documents[0].text).toContain('Comments: 50');
  });

  it('uses HN URL when story has no external URL', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [
            {
              objectID: '456',
              title: 'Ask HN',
              url: undefined,
              points: 10,
              num_comments: 5,
              author: 'user',
              created_at: '2024-01-15T00:00:00.000Z',
              story_text: 'Question text',
            },
          ],
        }),
    });

    const result = await sync(makeContext());
    expect(result.documents[0].url).toBe('https://news.ycombinator.com/item?id=456');
    expect(result.documents[0].text).toContain('Question text');
  });

  it('throws on API error', async () => {
    fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    await expect(sync(makeContext())).rejects.toThrow('HN API returned 500');
  });

  it('handles missing title gracefully', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [
            {
              objectID: '789',
              title: undefined,
              url: 'https://example.com',
              points: 1,
              num_comments: 0,
              author: 'u',
              created_at: '2024-01-15T00:00:00.000Z',
              story_text: '',
            },
          ],
        }),
    });

    const result = await sync(makeContext());
    expect(result.documents[0].title).toBe('Untitled');
  });

  it('returns null cursor and correct stats', async () => {
    fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(HN_RESPONSE) });

    const result = await sync(makeContext());
    expect(result.cursor).toBeUndefined();
    expect(result.stats.fetched).toBe(1);
  });

  it('handles missing points and comments', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [
            {
              objectID: '1',
              title: 'T',
              url: 'https://x.com',
              points: undefined,
              num_comments: undefined,
              author: 'u',
              created_at: '2024-01-15T00:00:00.000Z',
              story_text: undefined,
            },
          ],
        }),
    });

    const result = await sync(makeContext());
    expect(result.documents[0].text).toContain('Points: 0');
    expect(result.documents[0].text).toContain('Comments: 0');
  });

  it('reduces entity-encoded story_text HTML to plain text (no raw markup)', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [
            {
              objectID: '1',
              title: 'Ask HN: Something',
              url: '',
              points: 10,
              num_comments: 2,
              author: 'user',
              created_at: '2024-01-15T00:00:00Z',
              story_text:
                'See <a href="https:&#x2F;&#x2F;example.com&#x2F;archive">the archive</a> for details',
            },
          ],
        }),
    });

    const result = await sync(makeContext());
    const text = result.documents[0].text;
    expect(text).toContain('See the archive for details');
    expect(text).not.toContain('<a href');
    expect(text).not.toContain('&#x2F;');
  });
});
