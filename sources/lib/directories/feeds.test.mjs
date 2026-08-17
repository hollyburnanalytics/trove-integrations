import { describe, expect, it } from 'vitest';
import { makeDirectoryContext } from '../feed-fixtures.mjs';
import { advertisedFeeds, query } from './feeds.mjs';

/**
 * A directory context whose fetch returns a canned response.
 *
 * @param {string} body - The response body.
 * @param {boolean} [ok] - Whether the request succeeded.
 * @param {number} [status] - The status code.
 * @returns {ReturnType<typeof makeDirectoryContext>} The context.
 */
function contextReturning(body, ok = true, status = 200) {
  return makeDirectoryContext({ ok, status, text: async () => body });
}

const RSS =
  '<rss><channel><title>Simon Willison</title><item><title>A</title></item></channel></rss>';

describe('advertisedFeeds', () => {
  it('finds every feed a page advertises, not just the first', () => {
    // A site with separate post and comment feeds is exactly where guessing
    // picks wrong and a person picks right.
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="Posts" href="/feed">
      <link rel="alternate" type="application/rss+xml" title="Comments" href="/comments/feed">
    </head></html>`;
    expect(advertisedFeeds(html, 'https://s.test/')).toEqual([
      { url: 'https://s.test/feed', title: 'Posts' },
      { url: 'https://s.test/comments/feed', title: 'Comments' },
    ]);
  });

  it('accepts atom and JSON Feed alternates', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/atom+xml" href="/atom">
      <link rel="alternate" type="application/feed+json" href="/feed.json">
    </head></html>`;
    expect(advertisedFeeds(html, 'https://s.test/').map((f) => f.url)).toEqual([
      'https://s.test/atom',
      'https://s.test/feed.json',
    ]);
  });

  it('ignores alternates that are not feeds', () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="fr" href="/fr">
      <link rel="alternate" type="text/html" href="/print">
    </head></html>`;
    expect(advertisedFeeds(html, 'https://s.test/')).toEqual([]);
  });

  it('falls back to the page title when a link is unlabelled', () => {
    const html =
      '<html><head><title>Simon Willison</title>' +
      '<link rel="alternate" type="application/rss+xml" href="/feed"></head></html>';
    expect(advertisedFeeds(html, 'https://s.test/')[0]?.title).toBe('Simon Willison');
  });

  it('decodes entities in titles', () => {
    const html =
      '<html><head><link rel="alternate" type="application/rss+xml" ' +
      'title="Cats &amp; Dogs" href="/feed"></head></html>';
    expect(advertisedFeeds(html, 'https://s.test/')[0]?.title).toBe('Cats & Dogs');
  });

  it('de-duplicates the same feed advertised twice', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed">
      <link rel="alternate" type="application/rss+xml" href="https://s.test/feed">
    </head></html>`;
    expect(advertisedFeeds(html, 'https://s.test/')).toHaveLength(1);
  });

  it('refuses a non-http alternate, and keeps scanning', () => {
    // The page chose these hrefs. A javascript: alternate is not a feed, and
    // offering it would put it one click from becoming a subscription.
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/rss+xml" href="data:text/xml,<rss/>">
      <link rel="alternate" type="application/rss+xml" href="/good">
    </head></html>`;
    expect(advertisedFeeds(html, 'https://s.test/').map((f) => f.url)).toEqual([
      'https://s.test/good',
    ]);
  });
});

describe('feeds directory (resolve)', () => {
  it('resolves a feed address to itself, named by its channel', async () => {
    // Pasting a feed URL should confirm what it is, not reject it for not
    // being a web page.
    const entries = await query({ query: 'https://s.test/atom', limit: 10 }, contextReturning(RSS));
    expect(entries).toEqual([{ value: 'https://s.test/atom', title: 'Simon Willison' }]);
  });

  it('resolves a site address to the feeds it advertises', async () => {
    const html =
      '<html><head><title>Site</title>' +
      '<link rel="alternate" type="application/rss+xml" title="Posts" href="/feed"></head></html>';
    const entries = await query({ query: 'https://s.test', limit: 10 }, contextReturning(html));
    expect(entries).toEqual([{ value: 'https://s.test/feed', title: 'Posts' }]);
  });

  it('returns nothing for a page advertising no feeds', async () => {
    const context = contextReturning('<html><head><title>Nothing</title></head></html>');
    await expect(query({ query: 'https://s.test', limit: 10 }, context)).resolves.toEqual([]);
  });

  it('has no featured set — an empty address is not a request', async () => {
    const context = contextReturning(RSS);
    await expect(query({ query: '', limit: 10 }, context)).resolves.toEqual([]);
    await expect(query({ limit: 10 }, context)).resolves.toEqual([]);
    expect(context.fetch).not.toHaveBeenCalled();
  });

  it('reports an unreachable address rather than pretending it has no feeds', async () => {
    const context = contextReturning('', false, 404);
    await expect(query({ query: 'https://gone.test', limit: 10 }, context)).rejects.toThrow(/404/);
  });

  it('honours the limit', async () => {
    const links = Array.from(
      { length: 5 },
      (_, index) => `<link rel="alternate" type="application/rss+xml" href="/f${String(index)}">`,
    ).join('');
    const entries = await query(
      { query: 'https://s.test', limit: 2 },
      contextReturning(`<html><head>${links}</head></html>`),
    );
    expect(entries).toHaveLength(2);
  });
});
