# Trove Toolkits & Sources

[![CI](https://github.com/hollyburnanalytics/trove-integrations/actions/workflows/ci.yml/badge.svg)](https://github.com/hollyburnanalytics/trove-integrations/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Toolkits and sources that connect Trove (and the agent) to the outside world.
There are two **kinds** — see [`docs/taxonomy.md`](docs/taxonomy.md):

- **Toolkits** (`mcp/`) — named bundles of tools the agent **calls directly**,
  live, to read or act. Every toolkit runs as a full MCP server on Trove's
  cloud, built on the [`@ontrove/mcp`](mcp/README.md) SDK and sandboxed over
  public APIs. *(the current focus — see the [catalog](mcp/README.md))*
- **Sources** (`sources/`) — fetch content you can already access (your own
  feeds and accounts, public APIs, RSS/Atom, sitemaps, archives), polling on a
  cadence and tracking what's new, and **fill the searchable knowledge base**.
  Each is a module exporting `sync(ctx) → { documents, cursor, stats }`.

## Why Trove?

AI agents are powerful reasoners but poor data gatherers. Trove gives them two
ways to reach real data — **toolkits** they call live, and **sources** that fill
a searchable knowledge base in the background. On their own, agents struggle to:

- **Reach trustworthy data live** — query arXiv, SEC EDGAR, FRED, Wikidata, a map
  API, or the weather through one typed `/mcp` endpoint, instead of guessing.
- **Reach your own accounts and feeds** — your newsletters, your read-later
  list, your podcast queue.
- **Maintain state across sessions** — knowing what's already been fetched vs.
  what's new.
- **Access historical archives** — years of RSS history, paged API backfills.

Each **toolkit** is a sandboxed server over a public API; each **source**
encapsulates one feed or account's complexity — pagination, rate limiting,
incremental resume — behind a simple `sync(ctx) → documents` interface.

## What's Included

### Toolkits (`mcp/`) — called live by the agent

Read-only hosted toolkits over public APIs (plus one mutating toolkit, `resend`,
for send-email) — arXiv, Wikipedia, Wikidata, OpenAlex, Semantic Scholar, Open
Library, Internet Archive, Project Gutenberg, SEC EDGAR, FRED, World Bank, Canada
Open Data, OpenParliament, Mapbox, Open-Meteo, PubChem, openFDA, The Met, and
more. See the full catalog in [`mcp/README.md`](mcp/README.md).

### Sources (`sources/`) — fill the knowledge base

Filed by **subject**, Dewey-decimal style (folder name = category):

| Folder | What's in it |
|--------|--------------|
| `650-business` | Stratechery, Not Boring, AVC, Lenny's Newsletter, Bits about Money, SEC filings |
| `600-technology` | Benedict Evans, Simon Willison, Daring Fireball, Benn Stancil |
| `070-news` | Guardian / BBC / NYTimes / FT headlines, Hacker News, The Conversation |
| `330-economics` | Marginal Revolution |
| `500-science` | arXiv papers, Quanta Magazine |
| `300-social-sciences` | Our World in Data |
| `000-general` | Apple Podcasts, OpenStax, X bookmarks, any RSS feed |

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 — the project's package manager, runtime, and test
  runner (no Node toolchain required)

## Quick Start

```bash
bun install
```

### Run a source

The headless runner exercises any source through the same `context` contract
the app uses, printing the resulting documents, cursor, and stats:

```bash
# RSS source (no auth, instant)
bun run source sources/070-news/hacker-news --json
```

### Incremental sync

Sources return a `cursor` that you pass back on the next sync to skip
already-fetched content:

```javascript
const result1 = await sync(ctx);          // First sync: 48 documents
ctx.cursor = result1.cursor;              // Save cursor
const result2 = await sync({ ...ctx, cursor: result1.cursor }); // 0 new, 48 skipped
```

## Building a Source

The simplest source is 8 lines — an RSS feed URL and a prefix:

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

See [CLAUDE.md](CLAUDE.md) — the contributor guide written for both humans and
AI assistants — for the full reference: source types, shared helpers,
copy-paste patterns, and rules. Quick pointers in [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
bun run lint          # Biome: formatting + core lint
bun run lint:sonar    # ESLint (SonarJS + Unicorn): code quality
bun run typecheck     # tsc: toolkits (.ts) + sources (.mjs, checkJs)
bun run test          # bun test (all fetches mocked — no network)
bun run validate      # registry.json consistency
bun run check         # everything above: lint + lint:sonar + test + typecheck + validate
```

## License

Released under the [MIT License](LICENSE). © 2026 Hollyburn Analytics Inc.
