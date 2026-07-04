# Trove toolkit & source taxonomy

This repo holds **Trove toolkits and sources** — the things that connect Trove
(and the agent) to the outside world. There are two **kinds**, plus two
orthogonal modifiers. It's a *map for naming and organizing*, not a runtime
spec: the two kinds keep their own, deliberately separate engines (see the
warning at the end).

## Kinds

- **Toolkit** (`mcp/`) — a named bundle of tools the agent **calls directly**,
  live, to read or act. Synchronous; every toolkit runs as a full MCP server on
  Trove's cloud. *(an `@ontrove/mcp` `defineMcpServer`)*
- **Source** (`sources/`) — fills the searchable **knowledge base**. The agent
  reads it *indirectly* via `trove_search`. Stateful, runs on a harness.
  *(implemented by a source adapter: a scraper / feed / API poller)*

## Modifiers (apply to both kinds)

- **`trigger`** — `scheduled` (proactive, on a cadence) · `on-demand` (reactive).
- **`location`** — `cloud` (a Trove-hosted runtime) · `client` (runs on the
  user's own device, for sources that need local or on-device access).

## Where the data goes (a property of the result, not a kind)

A tool is fully described by what it reads and writes — and that's exactly the
capability grants it declares (`egress`, `trove:search`, `trove:ingest`):

| declares | pattern | example |
|---|---|---|
| `trove:search` | **KB-read** — query the cache | answer from my saved docs |
| `egress` | **ephemeral** — fetch live, return | weather, price |
| `egress` + `trove:ingest` | **write-through** — return + persist | fetch & index a paper |
| `egress` + `trove:search` + `trove:ingest` | **read-through cache** — check KB, fetch on miss, persist | "get me book X" |
| (none) + side effect | **action** (mutating) | send an email |
| `egress` + `trove:ingest`, scheduled, no tools | **source** | bulk scrape |

So a `source` is the limit case of "persist-only, scheduled, no live return," and
the read-through cache is literally KB-read + write-through composed. `persist`
is just "declares `trove:ingest`."

## Manifest fields

This page is a *conceptual map*, not the on-disk schema — the two kinds carry
deliberately different manifests. For the authoritative, validator-enforced
**source** schema, see [`source-adapter-taxonomy.md`](source-adapter-taxonomy.md) §4.

- **Source** (`sources/**/manifest.json`) — `id`, `name`, `description`, `icon`,
  `version`, `category`, `kind` (e.g. `scheduled-sync`), `transport`, `watermark`,
  `documentSemantics`, `schedule`, `status`, optional `available`.
- **Toolkit** (`mcp/**/manifest.json`) — `id`, `name`, `description`, `icon`,
  `version`, `sdk`, `tools[]`, `secrets[]`, `egress[]`, `scopes[]`, `visibility`.

The Source-vs-Toolkit distinction comes from the directory and manifest shape,
not a literal `"kind": "source" | "toolkit"` field; the `trigger` and `location`
axes above are descriptive, not manifest keys.

## ⚠️ Keep the runtimes separate

Conceptual unity ≠ implementation unity. A **scheduled bulk source** (loop a
record set, cursors/watermarks, pagination, durable retries, batched embedding)
and an **on-demand single fetch** (one synchronous call, return to the agent) are
different machines and must stay that way. The taxonomy names them as cells in
one grid; it does **not** ask you to run a source as a cron-scheduled tool.
On-demand single ingest reuses the existing single-document save path — never the
bulk harness.
