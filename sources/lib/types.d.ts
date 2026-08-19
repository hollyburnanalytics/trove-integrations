/**
 * The shapes every source adapter passes around.
 *
 * These are declarations, not code: the adapters are `.mjs` and stay that way,
 * and this file is what `checkJs` reads their JSDoc against. Before it existed
 * the recurring annotation was `@param {object} item`, which typechecks as
 * "some object" — so `item.titel` was as valid as `item.title`, and 360 of the
 * repo's first strict-mode errors were exactly that: real property accesses on
 * a type that declared no properties at all.
 *
 * Referenced from JSDoc as `@param {import('./types.d.ts').FeedItem} item`.
 *
 * @module
 */

/**
 * One user-supplied setting. The manifest's field types are `text`, `url`,
 * `url[]`, `text[]`, `number` and `boolean`; this is their union.
 */
export type ConfigValue = string | number | boolean | string[] | undefined;

/** Where a source or a directory provider reports what it is doing. */
export interface LogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** How a source talks to the runtime that invoked it. */
export interface SyncContext {
  /**
   * User-supplied settings, from the manifest's `config` schema.
   *
   * NOT `Record<string, string>`, which is what this was declared as and is not
   * what it holds: a `url[]`/`text[]` field arrives as an array, and every
   * fan-out source reads one. A source must therefore narrow before using a
   * value — see {@link stringList} — because config is user input and a field
   * that should be a list can arrive as a bare string.
   */
  config: Record<string, ConfigValue>;
  /** Credentials resolved from the vault, keyed by the manifest's `secrets`. */
  credentials: Record<string, string>;
  /**
   * Whatever this source returned as `cursor` on its previous run, handed back
   * verbatim. Declared as the shapes the catalog actually writes — a source
   * keeping a bespoke checkpoint (openstax) says so at its own boundary.
   */
  cursor?: Cursor;
  /** A Playwright browser context, for a `needsBrowser` source. */
  browser?: unknown;
  /**
   * Epoch ms after which the source should stop and return what it has.
   *
   * A SOFT budget: the runtime's hard timeout sits beyond it, and the margin
   * covers the last in-flight fetch plus the cursor write. A source that runs
   * past it has its whole round discarded, cursor included.
   */
  deadline: number;
  log: LogSink;
  /** Report progress mid-run: how many documents so far, and what is happening. */
  progress(documentsSoFar: number, message: string): void;
}

/**
 * How a directory provider reaches the network.
 *
 * `fetch` is the seam's, never the global: it carries the SSRF guard and the
 * size cap, and for a provider that declares an auth strategy it is also where
 * the request is signed. A provider handles no credentials of its own — which
 * is a requirement, not a style, for the ones whose terms bar shipping keys in
 * an open repository.
 */
export interface DirectoryContext {
  fetch(url: string): Promise<Response>;
  log: LogSink;
}

/** What a directory query asks for. `query` is empty when nobody has typed yet. */
export interface DirectoryQuery {
  query?: string;
  limit: number;
}

/**
 * One candidate a directory offers for a config field.
 *
 * Everything past `value` and `title` is display: a client shows what it has
 * and omits what it does not, so a provider that knows less still works.
 */
export interface DirectoryEntry {
  /** Written into the config field when this row is chosen. */
  value: string;
  title: string;
  subtitle?: string;
  description?: string;
  imageUrl?: string;
  /** How many items the candidate holds, with the word for one of them. */
  itemCount?: number;
  itemNoun?: string;
  /** ISO-8601 of the newest item, so a client can demote dormant candidates. */
  latestAt?: string;
}

/**
 * One document a source hands to the platform.
 *
 * At least one of `text`, `audioUrl` or `fileUrl` must be present — a
 * document with none of them has no body, and the harness rejects it.
 */
export interface TroveDocument {
  /** Stable across runs: the same content must produce the same id forever. */
  id: string;
  title: string;
  /** The body, inline. */
  text?: string;
  url?: string;
  author?: string;
  /** ISO-8601. Omitted — never faked — when the item carries no usable date. */
  date?: string;
  tags?: string[];
  /** An audio enclosure the platform transcribes. */
  audioUrl?: string;
  /** A file (e.g. a PDF) the platform retains and extracts. */
  fileUrl?: string;
  mimeType?: string;
  /**
   * A second artifact to try when {@link fileUrl} cannot be retrieved or
   * extracted — the rendering that always exists, behind the one that is
   * better. arXiv is the case this exists for: its LaTeXML HTML carries every
   * formula's source, but only for papers new enough to have been converted,
   * and the PDF is there for the rest.
   */
  fallback?: { fileUrl: string; mimeType: string };
  contentType?: string;
  metadata?: Record<string, unknown>;
}

/** An enclosure attached to a feed item. */
export interface FeedEnclosure {
  url: string;
  type: string;
  length?: number;
}

/** One item parsed out of an RSS `<item>`, an Atom `<entry>`, or a JSON Feed. */
export interface FeedItem {
  title: string;
  link: string;
  /** Plain-text summary. Capped at 1000 chars for Atom and JSON Feed. */
  description: string;
  /** The item's rich body markup, when it publishes one. */
  content: string;
  /** The fullest body available: `content` if there is one, else the summary. */
  bodyHtml: string;
  pubDate: string;
  author: string;
  /** The publisher's own identity for the item; falls back to `link`. */
  guid: string;
  categories: string[];
  enclosure?: FeedEnclosure;
  /**
   * The channel's own `<title>` — the publication's name, distinct from
   * `author`. A podcast feed names the SHOW here while its items name the
   * hosts. `''` for a bare fragment with no feed element.
   */
  feedTitle?: string;
  /**
   * The channel's `<itunes:new-feed-url>`: where the show says it has
   * permanently moved. `''` when it advertises no move. RSS only.
   */
  feedNewUrl?: string;
  /**
   * The resolved document URL, attached by the caller after parsing rather than
   * by the parser.
   */
  url?: string;
}

/** One subscribed feed within a multi-feed source. */
export interface Feed {
  url: string;
  /** What to call it in logs, when the config named it. */
  label?: string;
}

/** One collected item, paired with the epoch ms its date parsed to (NaN if undated). */
export interface FeedEntry {
  document: TroveDocument;
  ms: number;
}

/**
 * What fetching one feed produced: its items, or the error that stopped it.
 *
 * A union, not one optional-everything shape, so `if (outcome.error)` narrows
 * to the arm that HAS items. The batch loop collects successes and failures
 * into the same array and decides per outcome — a failed feed still has to be
 * named in the warning, which is why `feed` is on both arms.
 */
export type FeedOutcome =
  | {
      feed: Feed;
      items: FeedItem[];
      /** The 301 target, when the feed reported one. */
      movedPermanentlyTo?: string;
      error?: undefined;
    }
  | { feed: Feed; items?: undefined; movedPermanentlyTo?: undefined; error: Error };

/**
 * A resume cursor.
 *
 * The PLATFORM treats this as opaque — it stores whatever a source returns and
 * hands it back untouched. Within the catalog it is not opaque at all: these
 * are the shapes `@ontrove/sdk` reads and writes, and declaring them is what
 * lets a source (or its tests) assert on the cursor it produced instead of
 * reaching into an `unknown`.
 *
 * RE-EXPORTED from the SDK, not declared again. This was a local alias of the
 * SDK's `Cursor` — the catalog had already settled on the word `cursor`
 * while the package still said `cursor`, and the alias was the seam between
 * them. The package now says `cursor` too, so the two names are one name and
 * the alias became `type Cursor = Cursor`. The arms are the SDK's: `date`,
 * `idSet`, and the `none` this catalog's sources express by returning nothing.
 */
export type { Cursor } from '@ontrove/sdk';

/** What a source's `sync()` returns. */
export interface SyncResult {
  documents: TroveDocument[];
  /** Where to resume. Handed back verbatim on the next run. */
  cursor?: Cursor;
  stats?: Record<string, unknown>;
  /**
   * What the subscription calls itself, learned from the feed's own `<title>`.
   *
   * SINGLE-FEED SOURCES ONLY. A source polling twenty feeds has twenty titles
   * and no basis for picking one, so `selfReport` returns nothing at all rather
   * than the first — see `feed-identity.mjs`.
   */
  feedName?: string;
  /**
   * Where the feed says it has permanently moved to. Single-feed only, for the
   * same reason as {@link feedName}. Never the source's identity — the
   * `external_key` does not move.
   */
  feedUrl?: string;
}

/**
 * The walk state threaded through the HTML → Markdown renderer.
 *
 * Both fields exist because a Markdown construct's legality depends on where it
 * sits: a list needs to know its nesting to indent, and a table cell cannot
 * contain a block at all.
 */
export interface MarkdownContext {
  /** How many lists deep the walk is; 0 outside any list. */
  listDepth: number;
  /** Inside a table cell, where block constructs are illegal. */
  inTable: boolean;
}

/**
 * Where rendered Markdown fragments go.
 *
 * Structural, not a plain array: "what may be emitted next" depends on what was
 * emitted last (a leading space after a newline reads as an indented code
 * block), so the sink owns that memory rather than each caller tracking it.
 */
export interface MarkdownSink {
  /** Emit already-rendered Markdown verbatim. */
  raw(value: string): void;
  /** Emit source text, escaped for its position. */
  text(value: string): void;
  /** Whether the next emit would begin a line. */
  atLineStart(): boolean;
  /** Absorb an immediately preceding emphasis span using the same marker. */
  mergeEmphasis(marker: string): boolean;
  /** Everything emitted so far, joined. */
  toString(): string;
}
