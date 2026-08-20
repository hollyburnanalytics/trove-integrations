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
  log: LogChannel;
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
  document: Document;
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
 * are the shapes `@ontrove/extend/source` reads and writes, and declaring them is what
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
// Imported as well as re-exported below, and that is not redundant: a bare
// `export type { … } from` re-exports a name WITHOUT binding it in this
// module's scope. Every local `Document` then resolved to the DOM's global
// `Document` — silently, because it is a real type and the file still compiled.
// `FeedEntry.document` was typed as an HTML document for exactly as long as it
// took someone to notice. (`location` has the same five-way collision; see the
// migration notes.)
import type { Document, LogChannel } from '@ontrove/extend/source';

/**
 * The vocabulary the platform defines, re-exported so a source has ONE place to
 * import a type from.
 *
 * These were declared locally until 2026-08-20 — `SourceContext`, `SourceSyncResult`,
 * `Document`, `LogChannel` — a second name for each of four concepts
 * `@ontrove/extend` already named. Nothing compared the two copies, because a
 * source exported a bare `sync` function that no interface was checked against,
 * so they drifted: the local context had `credentials` and no `fetch`, the
 * local document had no `captureOnly`, the local result's `stats` was an
 * untyped bag. `defineSource` is what connects them, and it found 730
 * mismatches across the two catalogs the first time it ran.
 *
 * Add nothing here that the package already names. A local type earns its place
 * by being about THIS catalog's helpers — `Feed`, `FeedItem`, `MarkdownSink` —
 * not by restating the contract.
 */
export type {
  Cursor,
  Document,
  ExtensionCache,
  LogChannel,
  SourceContext,
  SourceSyncResult,
} from '@ontrove/extend/source';

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
