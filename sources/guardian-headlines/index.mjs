/**
 * The Guardian source
 *
 * Fetches headlines and summaries from The Guardian's public RSS feeds.
 * No auth required — RSS feeds are open.
 *
 * Supports multiple sections via config.sections (default: uk, world, technology, business).
 * Available sections: uk, world, technology, business, science, environment,
 * politics, commentisfree, sport, football, culture, film, music, books, etc.
 */

import { defineSource, stringList } from '@ontrove/extend/source';
import { feedItemDocument, syncFeeds } from '../lib/feed-sync.mjs';

const BASE_URL = 'https://www.theguardian.com';
const DEFAULT_SECTIONS = ['uk', 'world', 'technology', 'business'];

/** The trailer the feed appends to every summary. */
const BOILERPLATE = 'Continue reading...';

/**
 * Build one Guardian document, with the feed's boilerplate trailer removed.
 *
 * @param {import('../lib/types.d.ts').FeedItem} item - The parsed feed item.
 * @returns {import('../lib/types.d.ts').Document} The document.
 */
function toDocument(item) {
  const document = feedItemDocument('guardian', item, {
    defaultAuthor: 'The Guardian',
    tags: item.categories,
  });
  // The feed appends a boilerplate "Continue reading" link to every summary —
  // all 45 items in a live pull carry it. Two forms, because the body reaches
  // here as the feed's PLAIN-TEXT summary (`item.description`, already
  // tag-stripped) where the anchor is just its label; the markdown form only
  // survives on the full-text path. Stripping only the markdown form left the
  // boilerplate on every Guardian document.
  const withoutLink = document.text
    .replaceAll(/\[Continue reading\.\.\.\]\([^)]*\)/gi, '')
    .trimEnd();
  // Suffix check rather than a `\s*…\s*$` regex, which backtracks (ReDoS).
  document.text = withoutLink.toLowerCase().endsWith(BOILERPLATE.toLowerCase())
    ? withoutLink.slice(0, -BOILERPLATE.length).trim()
    : withoutLink.trim();
  return document;
}

export default defineSource({
  id: 'guardian-headlines',
  name: 'Guardian Headlines',
  description: 'Top headlines and summaries from The Guardian via RSS (no full article text)',
  icon: '📰',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'feed',
  cursor: 'date',
  ingest: 'append',
  runsIn: 'cloud',
  schedule: 'every 2 hours',
  status: 'implemented',
  needsBrowser: false,
  egress: ['www.theguardian.com'],
  historyReach: {
    kind: 'recent-only',
    note: 'A news feed carries only what is on the front page now — typically the last day or two. Older stories are not in the feed and cannot be fetched.',
  },
  config: {
    sections: {
      label: 'Sections to fetch',
      type: 'array',
      default: ['uk', 'world', 'technology', 'business'],
    },
  },
  async sync(context) {
    // `sections` is a `text[]` field, and a `text[]` field is user input: one
    // section typed into a list arrives as a bare string, on which `.map` throws
    // and takes the whole round with it. `stringList` is the narrowing every
    // fan-out source owes its config.
    const configured = stringList(context.config?.sections);
    const sections = configured.length > 0 ? configured : DEFAULT_SECTIONS;
    return syncFeeds(context, {
      feeds: sections.map((section) => ({ url: `${BASE_URL}/${section}/rss`, label: section })),
      label: 'Guardian sections',
      toDocument,
    });
  },
});
