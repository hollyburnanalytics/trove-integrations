# Contributing to Trove Integrations

Thanks for your interest in contributing! This repo is a collection of small,
self-contained **connectors** (data sources) and **MCP servers** (tools). Most
contributions add or fix a single connector, which keeps PRs easy to review.

## Getting started

```bash
bun install
bun run test          # all tests (fetches are mocked — no network)
bun run check         # full gate: lint + lint:sonar + tests with coverage + typecheck + validate
```

Requirements: [Bun](https://bun.sh) ≥ 1.2 (Bun is the package manager, runtime,
and test runner — no Node toolchain required). See the
[README](README.md#requirements) for details.

## Adding a connector

The full guide — connector types, shared helpers, copy-paste patterns, and the
rules — lives in [`CLAUDE.md`](CLAUDE.md) (written to be useful to both humans and
AI assistants). The short version:

1. Create `sources/{category}/{connector-id}/` with a `manifest.json` and
   `index.mjs` that exports `async function sync(ctx)`.
2. Reuse the shared helpers in `sources/lib/feeds.mjs`
   (`syncRSS`, `syncFeedArticles`, …) instead of re-writing RSS/HTML parsing.
3. Add a test that mocks `fetch` (see `sources/070-news/hacker-news/index.test.mjs`).
4. Run `bun scripts/validate-registry.mjs --fix` to register the connector.

## Before you open a PR

All of these must pass with zero errors (CI enforces them):

```bash
bun run lint          # Biome — formatting + core lint (all files)
bun run lint:sonar    # ESLint (SonarJS + Unicorn) — JS idioms (.mjs)
bun run typecheck     # tsc — MCP servers (.ts) + connectors (.mjs, checkJs)
bun run test          # bun's built-in test runner
bun run validate      # registry.json consistency
```

Please also:

- Keep IDs stable (same content → same `id`) and return the full
  `{ documents, cursor, stats }` envelope.
- Add a polite `delayMs` (200–500ms) between requests when scraping.

## Reporting bugs & requesting connectors

Use the [issue templates](.github/ISSUE_TEMPLATE). For security issues, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
