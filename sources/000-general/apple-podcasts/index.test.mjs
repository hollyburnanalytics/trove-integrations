import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stableId } from '../../lib/feeds.mjs';
import { sync } from './index.mjs';

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** SQLite NULL sentinel (the SQLite driver rejects `undefined` binds). */
const DB_NULL = JSON.parse('null');

/** Convert an ISO date to Core Data seconds (the library's ZPUBDATE unit). */
function toAppleSeconds(iso) {
  return new Date(iso).getTime() / 1000 - APPLE_EPOCH_OFFSET_SECONDS;
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Build a minimal MTLibrary.sqlite mirroring the Core Data schema the
 * source queries: ZMTPODCAST (shows) and ZMTEPISODE (episodes).
 */
function makeLibrary(root, { podcasts = [], episodes = [] } = {}) {
  mkdirSync(path.join(root, 'Documents'), { recursive: true });
  const database = new Database(path.join(root, 'Documents', 'MTLibrary.sqlite'));
  database.exec(`
    CREATE TABLE ZMTPODCAST (Z_PK INTEGER PRIMARY KEY, ZSUBSCRIBED INTEGER, ZTITLE TEXT);
    CREATE TABLE ZMTEPISODE (
      Z_PK INTEGER PRIMARY KEY, ZPODCAST INTEGER, ZGUID TEXT, ZUUID TEXT,
      ZTITLE TEXT, ZITUNESSUBTITLE TEXT, ZPUBDATE REAL, ZWEBPAGEURL TEXT,
      ZENCLOSUREURL TEXT, ZFREEENCLOSUREURL TEXT
    );
  `);
  const insertPodcast = database.prepare(
    'INSERT INTO ZMTPODCAST (Z_PK, ZSUBSCRIBED, ZTITLE) VALUES (?, ?, ?)',
  );
  for (const p of podcasts) insertPodcast.run(p.pk, p.subscribed ? 1 : 0, p.title ?? DB_NULL);
  const insertEpisode = database.prepare(
    `INSERT INTO ZMTEPISODE
     (ZPODCAST, ZGUID, ZUUID, ZTITLE, ZPUBDATE, ZWEBPAGEURL, ZENCLOSUREURL, ZFREEENCLOSUREURL)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const episode of episodes) {
    insertEpisode.run(
      episode.podcast,
      episode.guid ?? DB_NULL,
      episode.uuid ?? DB_NULL,
      episode.title ?? DB_NULL,
      toAppleSeconds(episode.date),
      episode.webpageUrl ?? DB_NULL,
      episode.enclosureUrl ?? DB_NULL,
      episode.freeEnclosureUrl ?? DB_NULL,
    );
  }
  database.close();
}

describe('apple-podcasts source', () => {
  let root;
  let originalHome;

  function makeContext(overrides = {}) {
    return {
      log: { info: mock(), warn: mock(), error: mock() },
      progress: mock(),
      config: { libraryRoot: root },
      credentials: {},
      cursor: undefined,
      deadline: Date.now() + 30_000,
      ...overrides,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'apple-podcasts-test-'));
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalHome === undefined) Reflect.deleteProperty(process.env, 'HOME');
    else process.env.HOME = originalHome;
    jest.restoreAllMocks();
  });

  it('emits recent episodes of subscribed shows as audio documents', async () => {
    makeLibrary(root, {
      podcasts: [
        { pk: 1, subscribed: true, title: 'Sharp Tech' },
        { pk: 2, subscribed: false, title: 'Unfollowed Show' },
      ],
      episodes: [
        {
          podcast: 1,
          guid: 'ep-1',
          title: 'A great episode',
          date: daysAgoIso(2),
          webpageUrl: 'https://sharptech.fm/ep-1',
          enclosureUrl: 'https://cdn.example/ep-1.mp3',
        },
        {
          podcast: 2,
          guid: 'ep-x',
          title: 'From an unfollowed show',
          date: daysAgoIso(1),
          enclosureUrl: 'https://cdn.example/ep-x.mp3',
        },
      ],
    });

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(1);
    const document = result.documents[0];
    expect(document.audio_url).toBe('https://cdn.example/ep-1.mp3');
    expect(document.text).toBeUndefined();
    expect(document.title).toBe('A great episode');
    expect(document.author).toBe('Sharp Tech');
    expect(document.url).toBe('https://sharptech.fm/ep-1');
    expect(document.id).toMatch(/^apple-podcasts-/);
    expect(new Date(document.date).getTime()).toBeCloseTo(new Date(daysAgoIso(2)).getTime(), -4);
    expect(result.stats).toMatchObject({ fetched: 1, skipped: 0, remaining: 0 });
  });

  it('logs the episode title and show when queuing for transcription', async () => {
    makeLibrary(root, {
      podcasts: [{ pk: 1, subscribed: true, title: 'Sharp Tech' }],
      episodes: [
        {
          podcast: 1,
          guid: 'ep-1',
          title: 'A great episode',
          date: daysAgoIso(2),
          enclosureUrl: 'https://cdn.example/ep-1.mp3',
        },
      ],
    });

    const context = makeContext();
    await sync(context);

    expect(context.progress).toHaveBeenCalledWith(1, 'Queued 1: "A great episode" — Sharp Tech');
  });

  it('limits the first run to the last 7 days', async () => {
    makeLibrary(root, {
      podcasts: [{ pk: 1, subscribed: true, title: 'Show' }],
      episodes: [
        {
          podcast: 1,
          guid: 'old',
          title: 'Old',
          date: daysAgoIso(10),
          enclosureUrl: 'https://a/old.mp3',
        },
        {
          podcast: 1,
          guid: 'new',
          title: 'New',
          date: daysAgoIso(3),
          enclosureUrl: 'https://a/new.mp3',
        },
      ],
    });

    const result = await sync(makeContext());

    expect(result.documents.map((d) => d.title)).toEqual(['New']);
  });

  it('resumes strictly after the date watermark and advances it to the newest emitted episode', async () => {
    const boundary = daysAgoIso(3);
    makeLibrary(root, {
      podcasts: [{ pk: 1, subscribed: true, title: 'Show' }],
      episodes: [
        {
          podcast: 1,
          guid: 'behind',
          title: 'Behind',
          date: daysAgoIso(5),
          enclosureUrl: 'https://a/1.mp3',
        },
        {
          podcast: 1,
          guid: 'at',
          title: 'At boundary',
          date: boundary,
          enclosureUrl: 'https://a/2.mp3',
        },
        {
          podcast: 1,
          guid: 'after',
          title: 'After',
          date: daysAgoIso(1),
          enclosureUrl: 'https://a/3.mp3',
        },
      ],
    });

    const result = await sync(makeContext({ cursor: { type: 'date', value: boundary } }));

    expect(result.documents.map((d) => d.title)).toEqual(['After']);
    expect(result.cursor.type).toBe('date');
    expect(new Date(result.cursor.value).getTime()).toBeCloseTo(
      new Date(daysAgoIso(1)).getTime(),
      -4,
    );
  });

  it('caps a large backlog per run, reporting the remainder and holding the cursor at the last emitted episode', async () => {
    const episodes = Array.from({ length: 30 }, (_, index) => ({
      podcast: 1,
      guid: `ep-${index}`,
      title: `Episode ${index}`,
      // Oldest first: ep-0 is 6 days old, each subsequent 2 hours newer.
      date: new Date(Date.now() - 6 * 86_400_000 + index * 7_200_000).toISOString(),
      enclosureUrl: `https://a/${index}.mp3`,
    }));
    makeLibrary(root, { podcasts: [{ pk: 1, subscribed: true, title: 'Show' }], episodes });

    const first = await sync(makeContext());

    expect(first.documents).toHaveLength(25);
    expect(first.documents[0].title).toBe('Episode 0');
    expect(first.documents[24].title).toBe('Episode 24');
    expect(first.stats.remaining).toBe(5);
    // The watermark sits on the newest *emitted* episode, so the next run
    // picks up exactly where this one stopped.
    const second = await sync(makeContext({ cursor: first.cursor }));
    expect(second.documents.map((d) => d.title)).toEqual([
      'Episode 25',
      'Episode 26',
      'Episode 27',
      'Episode 28',
      'Episode 29',
    ]);
    expect(second.stats.remaining).toBe(0);
  });

  it('skips episodes without an audio enclosure but moves the watermark past them', async () => {
    makeLibrary(root, {
      podcasts: [{ pk: 1, subscribed: true, title: 'Show' }],
      episodes: [
        { podcast: 1, guid: 'no-audio', title: 'Text only', date: daysAgoIso(2) },
        {
          podcast: 1,
          guid: 'paid',
          title: 'Free feed fallback',
          date: daysAgoIso(1),
          freeEnclosureUrl: 'https://a/free.mp3',
        },
      ],
    });

    const context = makeContext();
    const result = await sync(context);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].audio_url).toBe('https://a/free.mp3');
    expect(result.stats.skipped).toBe(1);
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('Text only'));
    // The skipped episode sits behind the watermark — it is never re-offered.
    expect(new Date(result.cursor.value).getTime()).toBeCloseTo(
      new Date(daysAgoIso(1)).getTime(),
      -4,
    );
  });

  it('holds the previous cursor when no new episodes exist', async () => {
    makeLibrary(root, { podcasts: [{ pk: 1, subscribed: true, title: 'Show' }] });
    const cursor = { type: 'date', value: daysAgoIso(1) };

    const result = await sync(makeContext({ cursor }));

    expect(result.documents).toHaveLength(0);
    expect(result.cursor).toBe(cursor);
  });

  it('falls back to the episode UUID and a default title when feed metadata is missing', async () => {
    makeLibrary(root, {
      podcasts: [{ pk: 1, subscribed: true, title: 'Show' }],
      episodes: [
        {
          podcast: 1,
          uuid: 'uuid-1',
          date: daysAgoIso(1),
          enclosureUrl: 'https://a/1.mp3',
        },
      ],
    });

    const result = await sync(makeContext());

    expect(result.documents[0].id).toBe(stableId('apple-podcasts', 'uuid-1'));
    expect(result.documents[0].title).toBe('Untitled episode');
    expect(result.documents[0].url).toBe('https://a/1.mp3');
  });

  it('tolerates a show without a title and names skipped episodes by guid', async () => {
    makeLibrary(root, {
      podcasts: [{ pk: 1, subscribed: true, title: undefined }],
      episodes: [
        { podcast: 1, guid: 'no-audio-no-title', date: daysAgoIso(2) },
        {
          podcast: 1,
          guid: 'ok',
          title: 'Has audio',
          date: daysAgoIso(1),
          enclosureUrl: 'https://a/1.mp3',
        },
      ],
    });

    const context = makeContext();
    const result = await sync(context);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].author).toBeUndefined();
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('no-audio-no-title'));
  });

  it('falls back to os.homedir() when $HOME is unset', async () => {
    process.env.HOME = '';
    makeLibrary(root, { podcasts: [], episodes: [] });

    const result = await sync(makeContext());

    expect(result.documents).toHaveLength(0);
  });

  it('fails with an actionable error when the Podcasts library does not exist', async () => {
    await expect(sync(makeContext())).rejects.toThrow(/Apple Podcasts library not found/);
  });

  it('explains the macOS app-data permission when the library cannot be opened', async () => {
    // A directory where the file should be makes SQLite's open fail the same
    // way a TCC denial does.
    mkdirSync(path.join(root, 'Documents', 'MTLibrary.sqlite'), { recursive: true });

    await expect(sync(makeContext())).rejects.toThrow(/access data from other apps/);
  });

  it('defaults the library root to the Podcasts group container under $HOME', async () => {
    process.env.HOME = root; // a home with no Podcasts library
    const context = makeContext({ config: {} });

    await expect(sync(context)).rejects.toThrow(
      /Library\/Group Containers\/243LU875E5\.groups\.com\.apple\.podcasts/,
    );
  });
});
