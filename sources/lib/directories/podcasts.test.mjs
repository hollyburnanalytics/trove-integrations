import { describe, expect, it, mock } from 'bun:test';
import { lookup, query } from './podcasts.mjs';

/** A directory context whose fetch returns a canned response. */
function contextReturning(response) {
  return { fetch: mock(async () => response), log: { info: mock(), warn: mock(), error: mock() } };
}

/** A JSON Response with the given status. */
function json(body, status = 200) {
  return Response.json(body, { status });
}

const FEED = {
  url: 'https://new.test/feed.xml',
  title: 'A Show',
  author: 'A Publisher',
  episodeCount: 12,
  newestItemPubdate: 1_754_000_000,
};

describe('podcasts directory lookup (repair)', () => {
  it('returns the show the index knows at a former address', async () => {
    const context = contextReturning(json({ feed: FEED }));
    const entry = await lookup('https://old.test/feed.xml', context);
    expect(entry).toMatchObject({ value: 'https://new.test/feed.xml', title: 'A Show' });
  });

  it('asks the index by feed URL', async () => {
    const context = contextReturning(json({ feed: FEED }));
    await lookup('https://old.test/feed.xml', context);
    const called = String(context.fetch.mock.calls[0][0]);
    expect(called).toContain('/podcasts/byfeedurl');
    expect(called).toContain(encodeURIComponent('https://old.test/feed.xml'));
  });

  it('treats 404 as a real answer, not a failure', async () => {
    // "The index has never heard of this feed" is information, and failing the
    // repair over it would turn a quiet miss into a noisy error.
    const context = contextReturning(json({}, 404));
    await expect(lookup('https://old.test/f', context)).resolves.toBeUndefined();
  });

  it('throws on a genuine upstream failure', async () => {
    const context = contextReturning(json({}, 500));
    await expect(lookup('https://old.test/f', context)).rejects.toThrow(/500/);
  });

  it('returns nothing when the index answers with no feed', async () => {
    for (const body of [{}, { feed: undefined }, { feed: [] }, { feed: 'nope' }]) {
      const context = contextReturning(json(body));
      await expect(lookup('https://old.test/f', context)).resolves.toBeUndefined();
    }
  });

  it('drops an entry the index cannot address', async () => {
    const context = contextReturning(json({ feed: { title: 'No URL' } }));
    await expect(lookup('https://old.test/f', context)).resolves.toBeUndefined();
  });

  it('still answers keyword searches', async () => {
    const context = contextReturning(json({ feeds: [FEED] }));
    const entries = await query({ query: 'a show', limit: 5 }, context);
    expect(entries).toHaveLength(1);
  });
});
