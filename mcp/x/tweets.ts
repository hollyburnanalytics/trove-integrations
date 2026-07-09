import { numOrNull, strOrNull } from './client.ts';

/**
 * The tweet model: turn raw X API payloads (`data` rows plus their `includes`
 * side-tables of users, referenced tweets and media) into clean, joined
 * {@link MappedTweet} shapes, parse a tweet id out of a raw id or status URL,
 * and render a tweet as a one-line human-readable summary.
 */

/** A joined-in author for a tweet. */
interface XUser {
  username: string | null;
  name: string | null;
  verified: boolean | null;
}

/** Index `includes.users` by id for author joins. */
export function indexUsers(includes: unknown): Map<string, XUser> {
  const map = new Map<string, XUser>();
  const arr =
    includes &&
    typeof includes === 'object' &&
    Array.isArray((includes as { users?: unknown }).users)
      ? (includes as { users: unknown[] }).users
      : [];
  for (const u of arr) {
    const o = u as Record<string, unknown>;
    if (typeof o.id === 'string') {
      map.set(o.id, {
        username: strOrNull(o.username),
        name: strOrNull(o.name),
        verified: typeof o.verified === 'boolean' ? o.verified : null,
      });
    }
  }
  return map;
}

/** Index `includes.tweets` (referenced/quoted/replied-to) by id. */
export function indexTweets(includes: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const arr =
    includes &&
    typeof includes === 'object' &&
    Array.isArray((includes as { tweets?: unknown }).tweets)
      ? (includes as { tweets: unknown[] }).tweets
      : [];
  for (const t of arr) {
    const o = t as Record<string, unknown>;
    if (typeof o.id === 'string') map.set(o.id, o);
  }
  return map;
}

/** A joined-in media attachment for a tweet. */
interface XMedia {
  type: string;
  url?: string;
  alt?: string;
}

/** Index `includes.media` by `media_key` so attachments can be joined onto tweets. */
export function indexMedia(includes: unknown): Map<string, XMedia> {
  const map = new Map<string, XMedia>();
  const arr =
    includes &&
    typeof includes === 'object' &&
    Array.isArray((includes as { media?: unknown }).media)
      ? (includes as { media: unknown[] }).media
      : [];
  for (const m of arr) {
    const o = m as Record<string, unknown>;
    const key = strOrNull(o.media_key);
    const type = strOrNull(o.type);
    if (!key || !type) continue;
    const entry: XMedia = { type };
    // Photos carry `url`; videos/gifs carry `preview_image_url` instead.
    const url = strOrNull(o.url) ?? strOrNull(o.preview_image_url);
    if (url) entry.url = url;
    const alt = strOrNull(o.alt_text);
    if (alt) entry.alt = alt;
    map.set(key, entry);
  }
  return map;
}

/** A `{ urls: [{ url, expanded_url }] }` entities bag (from a tweet or note_tweet). */
interface XEntities {
  urls?: { url?: unknown; expanded_url?: unknown }[];
}

/**
 * Replace each shortened `t.co` URL in `text` with its real destination, using
 * the matching `entities.urls[]` entry. Only exact `url` matches are replaced,
 * and an entry without an `expanded_url` is skipped.
 */
function expandTcoLinks(text: string, entities: unknown): string {
  const urls =
    entities && typeof entities === 'object' && Array.isArray((entities as XEntities).urls)
      ? (entities as { urls: unknown[] }).urls
      : [];
  let out = text;
  for (const u of urls) {
    const o = u as Record<string, unknown>;
    const shortUrl = strOrNull(o.url);
    const expanded = strOrNull(o.expanded_url);
    if (shortUrl && expanded) out = out.replaceAll(shortUrl, expanded);
  }
  return out;
}

/** A clean, mapped tweet. */
export interface MappedTweet {
  id: string;
  text: string;
  url: string | null;
  author: string | null;
  authorName: string | null;
  createdAt: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  media?: XMedia[];
}

/** Resolve a tweet's `attachments.media_keys` against the includes media index. */
function resolveMedia(raw: Record<string, unknown>, media: Map<string, XMedia>): XMedia[] {
  const attachments = raw.attachments;
  const keys =
    attachments &&
    typeof attachments === 'object' &&
    Array.isArray((attachments as { media_keys?: unknown }).media_keys)
      ? (attachments as { media_keys: unknown[] }).media_keys
      : [];
  const out: XMedia[] = [];
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    const m = media.get(k);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Map a raw X tweet to a clean shape, joining its author from `users` and any
 * attached media from `media`. Long posts use the untruncated `note_tweet.text`,
 * and `t.co` links are expanded to their real destinations.
 */
export function mapTweet(
  raw: Record<string, unknown>,
  users: Map<string, XUser>,
  media: Map<string, XMedia> = new Map(),
): MappedTweet {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const authorId = typeof raw.author_id === 'string' ? raw.author_id : null;
  const user = authorId ? users.get(authorId) : undefined;
  const handle = user?.username ?? null;
  const pm = (raw.public_metrics ?? {}) as Record<string, unknown>;
  const url = id
    ? handle
      ? `https://x.com/${handle}/status/${id}`
      : `https://x.com/i/status/${id}`
    : null;

  // Prefer the untruncated long-form body when present, expanding its t.co links
  // against the matching entities bag (note_tweet's own when long-form is used).
  const noteTweet = raw.note_tweet as { text?: unknown; entities?: unknown } | undefined;
  const noteText = noteTweet ? strOrNull(noteTweet.text) : null;
  const rawText = noteText ?? (typeof raw.text === 'string' ? raw.text : '');
  const entities = noteText ? noteTweet?.entities : raw.entities;
  const text = expandTcoLinks(rawText, entities);

  const mapped: MappedTweet = {
    id,
    text,
    url,
    author: handle ? `@${handle}` : null,
    authorName: user?.name ?? null,
    createdAt: strOrNull(raw.created_at),
    likes: numOrNull(pm.like_count),
    reposts: numOrNull(pm.retweet_count),
    replies: numOrNull(pm.reply_count),
    quotes: numOrNull(pm.quote_count),
  };
  const mediaItems = resolveMedia(raw, media);
  if (mediaItems.length > 0) mapped.media = mediaItems;
  return mapped;
}

/** A referenced (quoted/replied-to) tweet, tagged with its reference type. */
type ReferencedTweet = MappedTweet & { type: string | null };

/** An empty referenced-tweet placeholder for a ref X did not expand in the payload. */
function placeholderReference(refId: string): MappedTweet {
  return {
    id: refId,
    text: '',
    url: refId ? `https://x.com/i/status/${refId}` : null,
    author: null,
    authorName: null,
    createdAt: null,
    likes: null,
    reposts: null,
    replies: null,
    quotes: null,
  };
}

/**
 * Resolve a tweet's `referenced_tweets[]` against the includes index, mapping
 * each to a clean tweet (or a placeholder when X didn't expand it), tagged with
 * its reference type.
 */
export function mapReferencedTweets(
  rawTweet: Record<string, unknown>,
  tweetsIndex: Map<string, Record<string, unknown>>,
  users: Map<string, XUser>,
  media: Map<string, XMedia>,
): ReferencedTweet[] {
  if (!Array.isArray(rawTweet.referenced_tweets)) return [];
  const referenced: ReferencedTweet[] = [];
  for (const ref of rawTweet.referenced_tweets) {
    const ro = ref as Record<string, unknown>;
    const refId = typeof ro.id === 'string' ? ro.id : '';
    const refRaw = refId ? tweetsIndex.get(refId) : undefined;
    const mapped = refRaw ? mapTweet(refRaw, users, media) : placeholderReference(refId);
    referenced.push({ type: strOrNull(ro.type), ...mapped });
  }
  return referenced;
}

/** Parse a raw tweet id or an x.com/twitter.com status URL into a numeric id. */
export function parseTweetId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const statusMatch = /status(?:es)?\/(\d+)/.exec(trimmed);
  if (statusMatch?.[1]) return statusMatch[1];
  const numericMatch = /(\d{5,})/.exec(trimmed);
  return numericMatch?.[1] ?? null;
}

/** One-line, truncated preview of a tweet body for the human-readable summary. */
export function snippet(text: string, max = 140): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A single human-readable summary line for a mapped tweet. */
export function tweetLine(t: MappedTweet): string {
  const metrics = `${t.likes ?? 0} likes, ${t.reposts ?? 0} reposts, ${t.replies ?? 0} replies`;
  const when = t.createdAt ? `[${t.createdAt}] ` : '';
  return `  ${when}${snippet(t.text)} (${metrics})`;
}
