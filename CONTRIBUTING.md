# Contributing to Trove Toolkits & Sources

Thanks for your interest in contributing! This repo is a collection of small,
self-contained **sources** (they fill the knowledge base) and **toolkits**
(named bundles of tools; each runs as a full MCP server on Trove's cloud). Most
contributions add or fix a single source, which keeps PRs easy to review.

## Getting started

```bash
bun install
bun run test          # all tests (fetches are mocked — no network)
bun run check         # full gate: lint + lint:sonar + tests with coverage + typecheck + validate
```

Requirements: [Bun](https://bun.sh) ≥ 1.2 (Bun is the package manager, runtime,
and test runner — no Node toolchain required). See the
[README](README.md#requirements) for details.

## Adding a source

The full guide — source types, shared helpers, copy-paste patterns, and the
rules — lives in [`CLAUDE.md`](CLAUDE.md) (written to be useful to both humans and
AI assistants). The short version:

1. Create `sources/{category}/{source-id}/` with a `manifest.json` and
   `index.mjs` that exports `async function sync(ctx)`.
2. Reuse the shared helpers in `sources/lib/feeds.mjs`
   (`syncRSS`, `syncFeedArticles`, …) instead of re-writing RSS/HTML parsing.
   All network I/O must go through these helpers — never call raw `fetch()` when
   any part of a URL comes from `config`.
3. Add a test that mocks `fetch` (see `sources/070-news/hacker-news/index.test.mjs`).
4. Run `bun scripts/validate-registry.mjs --fix` to register the source.

A merged source can be promoted to run in Trove's cloud, so both authors and
reviewers should read the
[**Source Review Checklist**](docs/source-review-checklist.md) — network I/O
through the shared helpers, no dynamic code, no prototype/global mutation, no
timing-based cleverness, and `config` is preferences (never secrets). Some of it
is enforced by the gates below; the rest is reviewer judgment.

## Before you open a PR

All of these must pass with zero errors (CI enforces them):

```bash
bun run lint          # Biome — formatting + core lint (all files)
bun run lint:sonar    # ESLint (SonarJS + Unicorn) — JS idioms (.mjs)
bun run typecheck     # tsc — toolkits (.ts) + sources (.mjs, checkJs)
bun run test          # bun's own test runner
bun run validate      # registry.json consistency
```

Please also:

- Keep IDs stable (same content → same `id`) and return the full
  `{ documents, cursor, stats }` envelope.
- Add a polite `delayMs` (200–500ms) between requests when scraping.

## Reporting bugs & requesting sources

Use the [issue templates](.github/ISSUE_TEMPLATE). For security issues, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
