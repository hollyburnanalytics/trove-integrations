import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { stableId } from '../../lib/feeds.mjs';
import { advanceDateWatermark, readDateWatermark } from '../../lib/watermark.mjs';

/**
 * Apple Podcasts connector: the episodes of every show the user follows in the
 * macOS Podcasts app, emitted as audio documents for transcription.
 *
 * The Podcasts app's library (a Core Data SQLite store in its group container)
 * already holds the user's subscriptions, every episode's metadata, and the
 * audio enclosure URL — so the subscription list IS the configuration; there
 * is nothing to ask the user. Documents are emitted with `audio_url` and no
 * `text`: the server's transcription Workflow (Whisper) downloads the audio,
 * transcribes it, and indexes the transcript asynchronously.
 */

/** The Podcasts app's group container, relative to $HOME. */
const LIBRARY_RELATIVE_PATH = 'Library/Group Containers/243LU875E5.groups.com.apple.podcasts';

/** Core Data stores dates as seconds since 2001-01-01 (Apple epoch). */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/**
 * First-run lookback: how far back to transcribe when there is no watermark.
 * Each emitted episode costs a server-side Whisper transcription, so the
 * default window is deliberately small; deepen by resetting the cursor.
 */
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Max episodes emitted per run. Every audio document enqueues one
 * transcription Workflow server-side; the cap keeps a backlog draining in
 * polite slices across scheduled runs (the date watermark holds the rest).
 */
const MAX_EPISODES_PER_RUN = 25;

/**
 * Convert a Core Data timestamp to an ISO-8601 string.
 *
 * @param {number} coreDataSeconds - seconds since the Apple epoch
 * @returns {string}
 */
function appleDateToIso(coreDataSeconds) {
  return new Date((coreDataSeconds + APPLE_EPOCH_OFFSET_SECONDS) * 1000).toISOString();
}

/**
 * Open the Podcasts library read-only, translating the two predictable
 * failures (no Podcasts data on this Mac; macOS denied access to another
 * app's data) into actionable errors.
 *
 * Bun and Node ship different built-in SQLite modules with the same read API
 * (`.prepare(sql).all(params)` + `.close()`), so the connector runs under either
 * runtime — `bun:sqlite` under Bun, `node:sqlite` under Node.
 *
 * @param {string} databasePath
 * @returns {Promise<{ prepare: Function, close: Function }>}
 */
async function openLibrary(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(
      `Apple Podcasts library not found at ${databasePath} — is the Podcasts app set up on this Mac?`,
    );
  }
  try {
    if (globalThis.Bun) {
      const { Database } = await import('bun:sqlite');
      return new Database(databasePath, { readonly: true });
    }
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new Error(
      `Could not open the Apple Podcasts library (${error.message}). ` +
        'If macOS asked whether Trove may access data from other apps, allow it and sync again.',
    );
  }
}

export async function sync(context) {
  const home = process.env.HOME || homedir();
  const libraryRoot = context.config.libraryRoot || path.join(home, LIBRARY_RELATIVE_PATH);
  const databasePath = path.join(libraryRoot, 'Documents', 'MTLibrary.sqlite');

  const since = readDateWatermark(context.cursor) ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
  const sinceAppleSeconds = since.getTime() / 1000 - APPLE_EPOCH_OFFSET_SECONDS;

  const database = await openLibrary(databasePath);
  let rows;
  try {
    // Oldest-first so the capped slice + watermark never skips an episode:
    // the cursor only ever advances to the newest episode actually emitted.
    rows = database
      .prepare(
        `SELECT e.ZGUID AS guid, e.ZUUID AS uuid, e.ZTITLE AS title,
                e.ZITUNESSUBTITLE AS subtitle,
                e.ZPUBDATE AS pubdate, e.ZWEBPAGEURL AS webpageUrl,
                COALESCE(e.ZENCLOSUREURL, e.ZFREEENCLOSUREURL) AS enclosureUrl,
                p.ZTITLE AS showTitle
         FROM ZMTEPISODE e
         JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
         WHERE p.ZSUBSCRIBED = 1 AND e.ZPUBDATE > ?
         ORDER BY e.ZPUBDATE ASC`,
      )
      .all(sinceAppleSeconds);
  } finally {
    database.close();
  }

  context.log.info(
    `${rows.length} episode(s) newer than ${since.toISOString()} across subscribed shows`,
  );

  const documents = [];
  let skipped = 0;
  for (const row of rows) {
    if (documents.length >= MAX_EPISODES_PER_RUN) break;
    if (!row.enclosureUrl) {
      // No audio to transcribe (e.g. a paid show whose feed withholds the
      // enclosure). The watermark still moves past it via later episodes.
      context.log.warn(`No audio enclosure for "${row.title ?? row.guid}" — skipping`);
      skipped += 1;
      continue;
    }
    documents.push({
      id: stableId('apple-podcasts', row.guid || row.uuid),
      title: row.title || 'Untitled episode',
      author: row.showTitle || undefined,
      url: row.webpageUrl || row.enclosureUrl,
      date: appleDateToIso(row.pubdate),
      audio_url: row.enclosureUrl,
    });
    const show = row.showTitle ? ` — ${row.showTitle}` : '';
    context.progress(
      documents.length,
      `Queued ${documents.length}: "${row.title || 'Untitled episode'}"${show}`,
    );
  }

  const processed = documents.length + skipped;
  const remaining = rows.length - processed;
  const lastProcessed = processed > 0 ? rows[processed - 1] : undefined;

  return {
    documents,
    cursor: advanceDateWatermark({
      previous: context.cursor,
      maxIso: lastProcessed ? appleDateToIso(lastProcessed.pubdate) : undefined,
      anyFailed: false,
    }),
    stats: { fetched: documents.length, skipped, remaining },
  };
}
