import { stringList } from '@ontrove/sdk';
import { syncFeeds } from '../lib/feed-sync.mjs';
import { decodeHtmlEntities, safeDate, stableId } from '../lib/feeds.mjs';

/**
 * Podcasts source: episodes of any show the user subscribes to by feed URL,
 * emitted as audio documents for transcription.
 *
 * This is the cloud-hosted counterpart to `apple-podcasts`. That one reads the
 * macOS Podcasts app's local library, so it only runs on the user's Mac and
 * only covers shows followed in that app; this one takes podcast feed URLs the
 * same way `rss-feeds` takes blog feed URLs, and runs on Trove's servers.
 *
 * Documents carry `audioUrl` and no `text`: the server's transcription
 * workflow downloads the enclosure, transcribes it, and indexes the transcript
 * asynchronously. That makes each emitted episode genuinely expensive, which is
 * why this source is capped and lookback-limited (see below) where `rss-feeds`
 * is not.
 */

/**
 * First-run lookback: how far back to reach when a feed has no cursor yet.
 * A podcast feed routinely carries hundreds of back episodes, and every one we
 * emit buys a transcription — so a newly added show starts with its recent
 * episodes rather than its archive. Reset the cursor to reach further back.
 */
const FIRST_RUN_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Max episodes emitted per run, across all configured feeds. The rest are held
 * by the date cursor and drain over subsequent runs, oldest first.
 */
const MAX_EPISODES_PER_RUN = 25;

/**
 * Response-size cap for a podcast feed, over `fetchPage`'s 10 MB default.
 * A podcast feed is not a rolling window like an article feed — it carries
 * every episode the show has ever published, with full show notes. The Daily's
 * is 17.6 MB across 2,936 items and a16z's is 8.5 MB, so the default cap would
 * simply lock out the largest shows.
 */
const FEED_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How many feeds to fetch at once. Podcast feeds are both numerous (a normal
 * subscription list runs to dozens) and large, and a fetch is almost all
 * network wait — 22 real feeds take 27s in sequence, past the harness's 24s
 * soft deadline, which gets the whole run killed with neither documents nor a
 * cursor. Five at a time brings the same 22 well under 10s.
 */
const FEED_CONCURRENCY = 5;

/** Audio containers we accept when a feed omits the enclosure's MIME type. */
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);

/**
 * Whether an enclosure is audio we can send for transcription.
 *
 * `type` is the reliable signal and RSS requires it, so an explicit
 * non-`audio/*` type is rejected outright — that is how video episodes, PDF
 * show notes and cover art get filtered out. When a feed omits the type
 * entirely we fall back to the URL's file extension, checked on the pathname so
 * the tracking-prefix redirects podcast hosts use (`.../traffic.megaphone.fm/
 * ABC123.mp3?updated=…`) still resolve.
 *
 * @param {import('../lib/types.d.ts').FeedEnclosure | undefined} enclosure - The
 *   item's enclosure, when it has one.
 * @returns {enclosure is import('../lib/types.d.ts').FeedEnclosure} True when it
 *   is audio Trove can transcribe. A predicate rather than a boolean so the
 *   caller keeps the narrowing instead of re-checking the field it just proved.
 */
function isAudioEnclosure(enclosure) {
  if (!enclosure?.url) return false;
  if (enclosure.type) return enclosure.type.startsWith('audio/');
  try {
    const extension = new URL(enclosure.url).pathname.split('.').pop()?.toLowerCase();
    return extension !== undefined && AUDIO_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

/**
 * Build an audio document from a feed item, or `undefined` when the item has no
 * audio to transcribe — a text-only announcement, a video episode, or a paid
 * show whose public feed withholds the enclosure. `syncFeeds` counts those as
 * skipped rather than emitting a document with no body.
 *
 * @param {import('../lib/types.d.ts').FeedItem} item - a `parseRSS()` item, with resolved `url`
 * @returns {import('../lib/types.d.ts').TroveDocument | undefined} The audio
 *   document, or nothing when the item carries no audio.
 */
export function episodeDocument(item) {
  if (!isAudioEnclosure(item.enclosure)) return;
  return {
    id: stableId('podcast', item.guid || item.link),
    title: decodeHtmlEntities(item.title || 'Untitled episode'),
    // The SHOW, not the hosts. Trove attributes a podcast transcript to the
    // show's name, and `apple-podcasts` already emits it that way — so a show
    // synced by both routes lands under one author rather than two. The
    // item-level author is the wrong field here: Rational Reminder's episodes
    // carry "Benjamin Felix, Cameron Passmore, and Dan Bortolotti" in it, which
    // would split the library's view of the show. It is still the fallback for
    // a feed whose channel has no title.
    author: item.feedTitle || item.author || undefined,
    // The episode page when the feed links one, else the audio itself.
    url: item.link || item.enclosure.url,
    date: safeDate(item.pubDate),
    audioUrl: item.enclosure.url,
  };
}

/**
 * Sync this source: fetch what is new and return it as documents.
 *
 * @param {import('../lib/types.d.ts').SyncContext} context - The harness context.
 * @returns {Promise<import('../lib/types.d.ts').SyncResult>} The round's documents, cursor and stats.
 */
export async function sync(context) {
  const feeds = stringList(context.config.feeds).map((url) => ({ url }));
  return syncFeeds(context, {
    feeds,
    label: 'podcast feeds',
    emptyWarning: 'No podcast feeds configured',
    toDocument: episodeDocument,
    maxDocuments: MAX_EPISODES_PER_RUN,
    firstRunLookbackMs: FIRST_RUN_LOOKBACK_MS,
    feedMaxBytes: FEED_MAX_BYTES,
    concurrency: FEED_CONCURRENCY,
  });
}
