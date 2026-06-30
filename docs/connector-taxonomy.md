# Connector Taxonomy & MVP Scope

> **The normative type system for connectors.** This is the formalization the
> manifests are validated against (`scripts/validate-registry.mjs`): every
> connector declares four orthogonal type fields, and the validator enforces the
> enums and the MVP cut described here. The descriptive taxonomy (§1–§3) explains
> *why* the type system has the shape it does; §4 is the decided contract.

## 1. Why this doc

The SDK gives every connector one uniform contract — `sync(ctx) → { documents, cursor, stats }`.
That contract is expressive enough that every connector in this repo shares it cleanly, but
on its own it treats **collection shape and watermark semantics as an undeclared,
connector-private detail.** The manifest captures *topic* (`category`), *cadence*
(`schedule`), *browser-need* (`needs_browser`), and *auth* — but nothing about *how* a
connector collects or *how* it resumes. This doc names that taxonomy explicitly so we can
(a) reason about sync health, (b) decide what is in and out of MVP, and (c) evolve the
contract deliberately instead of stuffing new shapes into `sync()`.

The repo ships **source connectors** (under the Dewey-style categories
`000-general`, `070-news`, `300-social-sciences`, `330-economics`, `500-science`,
`600-technology`, `650-business`) and **MCP servers** (`mcp/`). `registry.json` is the
source of truth for the source connectors and is validated by
`scripts/validate-registry.mjs`.

## 2. The four dimensions

The catalog does not fit a single tree — it is four orthogonal axes that combine. These are
the axes that actually vary across connectors:

### ① Transport — how it reaches the data
`feed` (RSS/Atom) · `scrape` (feed/sitemap → full-text HTML extract) · `api` (JSON/REST) ·
`browser` (Playwright session) · `local` (on-device library / filesystem read with the
user's own OS permission)

### ② Watermark — how it avoids re-ingesting (the resume strategy)
- `date` — date high-water mark; dateless items always pass. Owned by `syncRSS()` /
  `syncFeedArticles()` (strict `>`; an inclusive `>=` variant is available for sources whose
  boundary needs it).
- `idSet` — an accumulating set of already-seen ids, bounded by `max` so it cannot grow
  without limit.
- `none` — no watermark; full head re-scan each run, relying on the harness's
  `UNIQUE(source_id, external_id)` dedup (e.g. `hacker-news`).

The watermark logic lives in the **shared helpers**, not the connectors — most connectors
just delegate. The connector returns a tagged `Watermark` value (§4.3), stored as JSON on the
source's cursor; the harness parses it to reason about the watermark's strategy and progress.

### ③ Fan-out — cardinality per run
`single` (one feed/page) · `multi-entity` (N companies, N queries) · `paged-scroll` (a scroll
loop with **no within-run checkpoint**)

### ④ Auth — where credentials live (always the Mac app's Keychain, never the cloud)
`none` (public) · `apiKey` · `cookies` (browser session) · `localPerms` (OS disk/library access)

## 3. Connector archetypes

The recurring dimension-combinations collapse into a handful of recognizable classes. The
ones below are the shapes the repo actually exercises:

| Class | Transport × Watermark × Fan-out | Helper | Exemplars |
|---|---|---|---|
| **Feed-poll** | feed × `date` × single | `syncRSS()` | `650-business/stratechery`, `000-general/rss-feeds` |
| **Full-text feed** | scrape × `date` × single | `syncFeedArticles()` | `500-science/quanta-magazine` |
| **API-poll** | api × `date`/`none` × single / multi-entity | direct `fetch` | `070-news/hacker-news` |
| **Local-store-sync** | local × `date` × single | direct read | `000-general/apple-podcasts` |
| **Authed-browser-harvest** | browser × `none` × paged-scroll | `ctx.browser` | — (harness-supported; none shipped) |

`syncFeedArticles()` is the one full-text exception to the repo's "store the syndicated
excerpt" default: for **Creative Commons / public-domain** feeds that carry only excerpts, it
fetches each new article *page* and extracts the body. All of these classes share the
`sync(ctx) → { documents, cursor }` contract cleanly.

Two further shapes are **named but reserved** (typed in §4 so the design is whole, not built):

- **On-demand fetch / query** — agent- or user-triggered retrieval of a single record by
  identifier, or a parameterized search returning a result set. This isn't a sync: there is
  no cursor and no schedule, and the trigger carries a required per-call input. It belongs to
  a `fetch()` / `query()` entrypoint surfaced as an MCP tool, not a connector the scheduler
  ticks.
- **Snapshot** — current-state sources (price / assessment / inventory) that want **upsert**
  semantics rather than append. The append-only ingest deliberately does
  `INSERT … ON CONFLICT(source_id, external_id) DO NOTHING`, which would skip changed content
  under a stable id, so snapshots need a different ingest mode.

## 4. Formalized type system

The taxonomy above is descriptive. This section is the **decided, normative type system** —
the manifest fields and SDK contract we commit to. Structure decision: **decomposed
orthogonal fields**, not a single archetype enum, so every real-world combination is
expressible (e.g. a snapshot API is `api` + `snapshot` + `upsert`, which a fixed archetype
table couldn't represent). Every type is *defined now* so the design is whole and
forward-compatible; the harness implements only the MVP column (§4.6). Adding a reserved
capability later means implementing an already-named type, not redesigning.

### 4.1 `kind` — execution contract (which entrypoint the harness invokes)

```ts
type ConnectorKind =
  | 'scheduled-sync'    // [built]    timer-driven, watermarked, append. The only built kind.
  | 'on-demand-fetch'   // [reserved] retrieve ONE record by id/url ("fetch this paper")
  | 'on-demand-query';  // [reserved] parameterized search → result set
```

### 4.2 `transport` — mechanism (descriptive; drives capabilities/permissions)

```ts
type Transport =
  | 'feed' | 'scrape' | 'api' | 'browser' | 'local';   // all built
```

`local` reads an on-device library or filesystem with the user's own OS permission (e.g.
`apple-podcasts`); it carries a `localPerms` auth requirement rather than a network credential.

### 4.3 `watermark` — typed resume strategy (discriminated union)

The **manifest declares the strategy** (static enum); the **source's cursor stores the value**
(dynamic, the tagged object below).

```ts
type Watermark =
  | { type: 'date';        value: string;    inclusive?: boolean }  // [built] strict '>'; inclusive '>='
  | { type: 'idSet';       values: string[]; max?: number }         // [built] bounded by `max`
  | { type: 'none' }                                                // [built] full re-scan + dedup
  | { type: 'highWaterId'; value: string }                          // [reserved] monotonic id
  | { type: 'opaqueToken'; value: string }                          // [reserved] provider delta/page token
  | { type: 'snapshot' }                                            // [reserved] current-state, no resume
  | { type: 'mtime';       value: string }                          // [reserved] local store
  | { type: 'rowid';       value: number };                         // [reserved] local store
```

The repo **builds and enforces** exactly three strategies: `date`, `idSet` (bounded by `max`
so it cannot grow without limit), and `none`. `highWaterId` and `opaqueToken` are typed in the
union but not yet wired — a connector that needs them today should use `none` (dedup is the
safety net).

### 4.4 `documentSemantics` — ingest behavior

```ts
type DocumentSemantics =
  | 'append'    // [built]    immutable; INSERT … ON CONFLICT(source_id, external_id) DO NOTHING
  | 'upsert';   // [reserved] mutable; replace on conflict. Unlocks the snapshot watermark.
```

### 4.5 Entrypoints — the sync / fetch split

```ts
export function sync(ctx: SyncContext): Promise<SyncResult>;                          // [built]
export function fetch(ctx: FetchContext, target: FetchTarget): Promise<FetchResult>;  // [reserved]
export function query(ctx: FetchContext, params: QueryParams): Promise<QueryResult>;  // [reserved]

interface SyncContext { cursor: Watermark | undefined; config; credentials; log; progress; browser? }
interface SyncResult  { documents: Document[]; cursor: Watermark | undefined; stats }
type     FetchTarget  = { url: string } | { id: string };
```

A connector declares `{ kind, transport, watermark, documentSemantics }`; the harness uses
`kind` to pick the entrypoint. **Today the harness only calls `sync`** — `fetch` / `query` are
typed now but unimplemented, so on-demand can be added later without a redesign.

### 4.6 The MVP cut

| Type family | Built + enforced | Reserved (typed now, built later) |
|---|---|---|
| `kind` | `scheduled-sync` | `on-demand-fetch`, `on-demand-query` |
| `transport` | feed, scrape, api, browser, local | — |
| `watermark` | date, idSet (bounded), none | highWaterId, opaqueToken, snapshot, mtime, rowid |
| `documentSemantics` | append | upsert |
| entrypoints | `sync` | `fetch`, `query` |

`validate-registry.mjs` enforces this cut: an implemented connector must be `scheduled-sync` /
`append`, with `watermark ∈ {date, idSet, none}` and `transport ∈ {feed, scrape, api, browser,
local}`.

### 4.7 Manifest example

```jsonc
{
  "id": "simon-willison", "name": "Simon Willison", "category": "600-technology",
  "kind": "scheduled-sync",        // execution contract
  "transport": "feed",             // mechanism
  "watermark": "date",             // strategy only; the value lives in the source's cursor
  "documentSemantics": "append",
  "needs_browser": false, "auth": {}, "schedule": "daily", "status": "implemented"
}
```

### 4.8 How the fields flow through the system

- **Scheduling is the executor's job.** The manifest `schedule` field is a **cadence hint**
  for whatever drives the connector, not authoritative state. The harness is the sole
  executor; it ticks the connector, calls `sync`, stores the returned documents, and advances
  the cursor.
- **The cursor is a typed `Watermark` value** (JSON), advanced by the harness via
  compare-and-swap as it ingests documents. Because the strategy is declared and the value is
  tagged, the harness can project sync state (strategy + synced-through date / tracked-id
  count) for display.
- **`connector → source → document`.** Multi-stream connectors (e.g. an `rss-feeds` connector
  with several feeds) are modeled as multiple sources, each with its own cursor. Fan-out
  *across streams* is handled; fan-out *within one run* (paged-scroll) is not checkpointed.
- **The four type fields travel with the connector instance**, so every layer that lists or
  schedules connectors can see a connector's shape — not just its name and icon.
