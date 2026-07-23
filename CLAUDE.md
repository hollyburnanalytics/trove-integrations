# Trove Toolkits & Sources

## Project Overview

This repo holds **Trove toolkits and sources** (see
[`docs/taxonomy.md`](docs/taxonomy.md)):

- **Toolkits** (`mcp/`) — named bundles of tools the agent calls live (every
  toolkit runs as a full MCP server on Trove's cloud); **the current focus of
  the repo.** Built and documented in [`mcp/README.md`](mcp/README.md).
- **Sources** (`sources/`) — source adapters that fill the knowledge base. **This
  guide covers Sources;** for Toolkits, see [`mcp/README.md`](mcp/README.md).

A **source** is a small, self-contained module (a source adapter) that fetches
data from an external system and returns structured documents. Each lives in
`sources/{category}/{source-id}/` with an `index.mjs` and `manifest.json`.

Sources are loaded by an external harness that calls `sync(ctx)` and handles storage, scheduling, and auth flows. The source adapter's only job is: given a context, fetch data and return documents.

## Dev Commands

```bash
bun run lint          # Check lint + formatting (Biome)
bun run lint:fix      # Auto-fix lint + formatting (Biome)
bun run lint:sonar    # Check code quality (ESLint + SonarJS + Unicorn)
bun run format        # Format all files
bun run format:check  # Check formatting without fixing
bun run test          # Run tests
bun run test:watch    # Run tests in watch mode
bun run test:coverage # Run tests with coverage report
bun run typecheck     # Typecheck both halves (toolkits + sources)
bun run check         # Full check: lint + lint:sonar + test with coverage + typecheck
bun run validate      # Validate registry.json consistency
```

### Toolchain matrix

Each file kind is covered by a deliberate set of tools (so nothing escapes a gate):

| Surface | Format + lint | Idiom lint | Type check | Tests |
|---------|:---:|:---:|:---:|:---:|
| `mcp/**/*.ts` (toolkits) | Biome | — | `tsc` strict (`mcp/tsconfig.json`) | `server.test.mjs` (mock `fetch` → real SDK path) |
| `sources/**`, `scripts/**`, `bin/**` (`.mjs`) | Biome | ESLint (SonarJS + Unicorn) | `tsc --checkJs` (`tsconfig.sources.json`) | co-located `*.test.mjs` |

Unicorn's JS-idiom rules run on the hand-written `.mjs` sources; the `.ts`
toolkits are covered by Biome + strict `tsc` instead. Both halves are type-checked
and the source half is checked via JSDoc/inference (`checkJs`).

## Environment

Dependencies are auto-installed by the devcontainer (`postCreateCommand` + `postStartCommand`). No manual `bun install` needed.

**Network & proxy:** The devcontainer routes all HTTP traffic through an egress proxy (JWT-authenticated, configured via `HTTP_PROXY`/`HTTPS_PROXY` env vars).

- **`bun install`/`curl`/`pip`** — work out of the box (inherit proxy from env vars). If `bun install` fails with 407 errors, retry — the proxy JWT token may have expired and been refreshed.
- **Bun's `fetch()`** — respects `HTTP_PROXY`/`HTTPS_PROXY` env vars, so live smoke tests (Step 4) run directly under `bun` with no extra setup.
- **Tests** must always mock `fetch` — see existing tests (e.g. `070-news/hacker-news/index.test.mjs`) for the pattern. Never rely on network access in tests.

## Architecture

```
sources/{category}/{source-id}/
  manifest.json    # metadata, location, schedule, config schema
  index.mjs        # exports async function sync(ctx) → { documents, cursor, stats }
```

### Categories
Sources are filed by **subject**, Dewey-decimal style — the folder name *is* the
manifest `category`, and the number gives stable ordering with gaps to grow into:

| Folder | Subject |
|--------|---------|
| `000-general` | containers with no fixed subject (generic RSS, podcasts) |
| `070-news` | news media & journalism |
| `300-social-sciences` | society & social sciences (e.g. global development data) |
| `330-economics` | economics |
| `350-public-administration` | public administration & government |
| `500-science` | science & research |
| `600-technology` | technology & computing |
| `650-business` | business, startups, finance |

File by *what the content is about*, not by format (a blog, a news feed, and a filing on
the same topic share a folder). Add a new class only when a source genuinely needs one;
pick a Dewey number that sorts it sensibly.

### Catalog identity (`sources/catalog.json`)

`sources/` is a **catalog** — it declares its identity in `sources/catalog.json`
(`"id": "hollyburnanalytics/trove-integrations"`). A source's stable cloud identity is
**`{catalog.id}/{source.id}`** — the **`category` is *not* part of identity**, so a
source can be re-filed into a different Dewey folder without orphaning its indexed
documents. Two consequences, both enforced by `bun run validate`:

- A source's **`id` must be unique across the whole catalog** (not just within its
  category), because it is the identity slug.
- A source's `id` is its **permanent identity** — renaming it re-registers it as a new
  source in the cloud. Treat `id` like the pinned catalog name: don't change it.

### Source Type System

Every manifest declares four orthogonal type fields (enforced by
`scripts/validate-registry.mjs`). See **`docs/source-adapter-taxonomy.md`** for the full
formalization and the MVP scope decision.

- **`kind`** — execution contract: `scheduled-sync` (only built kind) · `on-demand-fetch` · `on-demand-query` (reserved).
- **`transport`** — mechanism: `feed` · `scrape` · `api` · `browser` · `local` (all built).
- **`watermark`** — resume strategy: `date` · `idSet` · `none` (built) · `highWaterId` · `opaqueToken` · `snapshot` · `mtime` · `rowid` (reserved).
- **`documentSemantics`** — `append` (built) · `upsert` (reserved).

Implemented sources must stay within the **MVP cut** (`scheduled-sync` / `append` /
watermark ∈ {`date`, `idSet`, `none`} / transport ∈ {`feed`, `scrape`, `api`, `browser`, `local`}).
Stubs may declare reserved values to encode where a shape is headed.

### `available` — temporarily hide a built source

A source is offered to users unless its manifest sets **`"available": false`**. We use
this to hide sources that are implemented but **need user input we can't collect yet**
— a config list (`config.feeds`/`channels`/`tickers`/…) or a browser login. They stay in the
repo and tests; the app just doesn't surface them. Remove the flag to offer them again once the
config/auth UI exists. Absent = available. (Currently off: rss-feeds, sec-filings, x-bookmarks.)

### Helpers by transport

| Transport | Auth | Example | Helper |
|-----------|------|---------|--------|
| `feed` (RSS/Atom) | none | `650-business/stratechery`, `000-general/rss-feeds` | `syncRSS()` / `parseRSS()` |
| `scrape` (CC full-text) | none | `500-science/quanta-magazine` | `syncFeedArticles()` |
| `api` (JSON/REST) | none **or** API key | `070-news/hacker-news` (keyless) | Direct `fetch` |

The repo favours **direct pulls** — public feeds and official/documented APIs — and stores
bodies as plain text (`htmlToText()`), no rich-Markdown reconstruction. The one exception is
`syncFeedArticles()`, which fetches the full article *page* when a feed carries only excerpts.
Use it **only for Creative Commons / public-domain sources** (note the license in the manifest
description), never all-rights-reserved feeds — for those, store the publisher's syndicated
excerpt via `syncRSS()`.

## Context Object (`ctx`)

The harness provides:
- `ctx.log` — `{ info(), warn(), error() }` logger (lines go to stderr)
- `ctx.progress(count, message)` — update sync progress
- `ctx.config` — source **preferences** from the manifest (feed URLs, sections — NO secrets)
- `ctx.credentials` — secrets sourced from the macOS Keychain (API keys, tokens); kept separate from `config` and never stored in the cloud
- `ctx.cursor` — previous cursor value (`undefined` on first sync)

## Return Shape

```javascript
{
  documents: [{ id, title, text, url, author, date, tags? }],
  cursor: { type: 'date', value } | undefined,  // typed Watermark value — see docs/source-adapter-taxonomy.md §4.3
  stats: { fetched, skipped? }
}
```

A document's body may take one of three forms (at least one is required):
inline `text`; an `audio_url` enclosure the server transcribes; or a
`file_url` + `mime_type` (e.g. a PDF) the server downloads, **retains** (the
app renders the original), and extracts into the body — any `text` sent
alongside `file_url` becomes the extraction header, so use it for metadata
(source, date, subject), not the content. See `350-public-administration/
dnv-council-minutes` for the `file_url` pattern.

## Shared Helpers (`sources/lib/feeds.mjs`)

**Use these instead of writing from scratch:**

- `syncRSS(ctx, { feedUrl, idPrefix, defaultAuthor })` — complete RSS/Atom sync with cursor support. Returns the full `{ documents, cursor, stats }` envelope. Most RSS sources are 8 lines.
- `parseRSS(xml)` — parse RSS `<item>` or Atom `<entry>` XML into `[{ title, link, description, content, pubDate, author, guid, categories }]`.
- `htmlToText(html)` — reduce an HTML (or already-plain) fragment to clean plain text (decode entities, strip tags). Used to store feed bodies.
- `syncFeedArticles(ctx, { feedUrl, idPrefix, defaultAuthor, articleSelector })` — for **CC/public-domain** feeds that carry only excerpts: fetch each new article page, extract `articleSelector`'s text, store the full body. Oldest-first, deadline-bounded, resumes via the `date` watermark.
- `fetchArticleText(url, selector)` — fetch one page and extract the selected container as plain text (falls back to `<article>`/`<main>`).
- `fetchPage(url)` — fetch with our honest bot UA + timeout + size cap, throws on non-200.
- `decodeHtmlEntities(text)` / `safeDate(str)` / `stableId(prefix, input)` — small text/date/id helpers.

## Creating a New Source

### Step 1: Determine the type

- Has an RSS/Atom feed? → Use `syncRSS()` (easiest, 8 lines)
- Has a JSON API? → Fetch directly

### Step 2: Create the files

```bash
mkdir -p sources/{category}/{source-id}
```

**manifest.json:**
```json
{
  "id": "my-source",
  "name": "My Source",
  "description": "What this source provides",
  "icon": "📄",
  "version": "0.1.0",
  "author": "Hollyburn Analytics Inc.",
  "category": "600-technology",
  "kind": "scheduled-sync",
  "transport": "feed",
  "watermark": "date",
  "documentSemantics": "append",
  "location": "cloud",
  "schedule": "daily",
  "status": "implemented",
  "config": {},
  "needs_browser": false,
  "live": false
}
```

`location` (`cloud` | `client`) is the source's default executor and is
required. A `feed`/`api`/`scrape` source with no browser and a real schedule
may be `cloud` (Trove-hosted sync); anything needing a browser or on-disk data
is `client` (the Mac harness). `config` is the **user-preferences** schema
(feed URLs, queries, sections) — never credentials. A fan-out source (one that
explodes a list into one feed per entry) adds `"fanOut": "<configKey>"` naming
a `config` field of type `url[]` or `text[]`.

Schedule must be one of: `every 30 minutes`, `every 1 hour`, `every 2 hours`, `every 4 hours`, `every 6 hours`, `every 12 hours`, `daily`, `weekly`, `monthly`, `yearly`, `on demand`.

**index.mjs** (RSS example):
```javascript
import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(ctx) {
  return syncRSS(ctx, {
    feedUrl: 'https://example.com/feed/',
    idPrefix: 'ex',
    defaultAuthor: 'Example Blog',
  });
}
```

### Step 3: Add to registry

Run `bun scripts/validate-registry.mjs --fix` to auto-add the source to `registry.json`.

### Step 4: Test

**Unit tests** (always works, uses mocks):
```bash
bun run test sources/{category}/{source-id}/
```

**Live smoke test** (works in and out of the devcontainer — `bun`'s `fetch` inherits the proxy):
```bash
bun -e "
const ctx = {
  log: { info: console.log, warn: console.warn },
  progress: () => {},
  config: {},
  cursor: undefined,
};
import('./sources/{category}/{source-id}/index.mjs')
  .then(m => m.sync(ctx))
  .then(r => {
    console.log(r.stats.fetched + ' docs');
    console.log(r.documents[0]);
    console.log('cursor:', r.cursor);
  });
"
```

## Source Patterns (Copy-Paste)

### RSS/Atom Feed (simplest — 8 lines)
```javascript
import { syncRSS } from '../../lib/feeds.mjs';

export async function sync(ctx) {
  return syncRSS(ctx, {
    feedUrl: 'https://example.com/feed/',
    idPrefix: 'ex',
    defaultAuthor: 'Example',
  });
}
```
Cursor: automatic — a typed `date` watermark (`{ type: 'date', value }`).

### Direct JSON API
```javascript
import { stableId } from '../../lib/feeds.mjs';

export async function sync(ctx) {
  const response = await fetch('https://api.example.com/items');
  if (!response.ok) throw new Error(`API ${response.status}`);
  const { items } = await response.json();
  return {
    documents: items.map((it) => ({
      id: stableId('ex', it.id),
      title: it.title,
      text: it.body,
      url: it.url,
      date: it.published,
    })),
    cursor: undefined,
    stats: { fetched: items.length },
  };
}
```

## Linting

This project uses complementary tools, applied per file kind (see the toolchain matrix above): **Biome** lints + formats everything; **ESLint (SonarJS + Unicorn)** adds JS-idiom rules to the hand-written `.mjs` sources; `tsc` type-checks both halves. All new and modified code must pass every gate that applies to it.

**Biome** (`bun run lint`) — formatting and core lint rules for all `.ts`/`.mjs` (configured in `biome.json`).

**ESLint with SonarJS + Unicorn** (`bun run lint:sonar`) — code quality, bug prevention, and modern JS conventions for the `.mjs` files (configured in `eslint.config.mjs`).

- **eslint-plugin-sonarjs** (recommended) — detects bugs, security issues (ReDoS-vulnerable regexes), cognitive complexity, and code smells.
- **eslint-plugin-unicorn** (recommended) — enforces modern JavaScript idioms: `replaceAll()` over regex replace, `undefined` over `null`, full variable names over abbreviations, `Number.isNaN` over global `isNaN`, etc.

All rules from both ESLint plugins are enabled at their recommended (strictest) settings. Do not disable rules without discussion.

## Rules

- Every source must export `async function sync(ctx)`.
- Always return `{ documents, cursor, stats }` — never a bare array.
- Use shared helpers when possible — don't rewrite RSS parsing. All network I/O
  goes through `lib/http.mjs`/`lib/feeds.mjs`; never raw `fetch()` when any part
  of a URL is config-derived (a source can run in Trove's cloud — see the
  [Source Review Checklist](docs/source-review-checklist.md)).
- IDs must be stable across syncs (same content → same ID).
- Cursor support is expected — use `ctx.cursor` for incremental sync.
- `delayMs` between requests to avoid hammering sources (200-500ms).
- Log progress: `ctx.log.info()` for milestones, `ctx.log.warn()` for recoverable errors.
- Throw on fatal errors (auth expired, source unreachable). Warn on per-item failures.
- Run `bun scripts/validate-registry.mjs --fix` after adding/modifying sources.
- All code must pass `bun run lint` and `bun run lint:sonar` with zero errors.

## Validation

```bash
bun scripts/validate-registry.mjs        # check for issues
bun scripts/validate-registry.mjs --fix   # auto-fix registry.json
```
