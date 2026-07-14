# Source Review Checklist

**Read this before reviewing (or opening) a source PR.**

A source that merges here can be promoted to run in **Trove's cloud** — a
manifest with `"location": "cloud"` is synced on Trove's servers rather than on
the user's own machine. Approving such a source into the catalog lets its code
run with the same privileges as first-party code. **Review is therefore a
security boundary, not only a style gate.** Client-located sources
(`"location": "client"`) run on the user's own device, but the same discipline
keeps the whole catalog trustworthy.

Every item below is either **enforced by the automated gates** (Biome, ESLint
with SonarJS + Unicorn, `tsc`, `bun run validate`) or **confirmed by a
reviewer** — the split is called out at the end.

## The checklist

### 1. Network I/O goes through the shared helpers

- All network access uses `sources/lib/http.mjs` / `sources/lib/feeds.mjs`:
  `fetchPage`, `syncRSS`, `syncFeeds`, `syncFeedArticles`, `fetchArticleText`.
  These carry the honest user agent, request timeouts, and response size caps —
  and, when a source runs in the cloud, host validation and safe (re-validated)
  redirect handling.
- **Never call raw `fetch()` when any part of the request URL is
  config-derived** — a feed URL, a search query, or a section name that came
  from the source's `config`. A URL built from user preferences must flow
  through a shared helper so it is validated before the request goes out. This
  is the single most important rule here: it is what prevents a config-supplied
  URL from reaching an address it shouldn't.
- Raw `fetch()` is acceptable **only for a fixed, hardcoded host** with no
  config-derived component (a single official API base), as in the existing
  `hacker-news` and `sec-filings` adapters.

### 2. No dynamic code

- No `eval`, no `new Function`, no dynamically-constructed `import()`, no
  fetching-then-executing remote code. A source is static, reviewable code and
  nothing else.

### 3. No prototype or global mutation

- Don't modify `Object.prototype` / `Array.prototype` / other built-ins, don't
  assign to `globalThis`, and don't monkeypatch the shared library exports. A
  source touches only its own inputs (`ctx`) and its return value.

### 4. No timing-based cleverness

- Behavior must not depend on wall-clock timing, races, or execution order —
  neither for correctness nor to change what the source does. The only
  sanctioned delay is the documented politeness `delayMs` (200–500ms) between
  requests. No code path should exist that only triggers under a particular
  timing.

### 5. Config is preferences, never secrets

- `config` (the manifest's user-preferences schema) holds feed URLs, queries,
  and section names — **never** API keys, tokens, or passwords. Secrets belong
  to `ctx.credentials`, which is kept separate from `config` and never stored in
  the cloud.

### 6. Contract discipline

- Exports `async function sync(ctx)`, returns the full
  `{ documents, cursor, stats }` envelope, uses stable IDs (same content → same
  `id`), resumes via `ctx.cursor`, and ships a test that **mocks `fetch`** (no
  network in tests). The contract tests and validator enforce most of this —
  confirm it anyway.

### 7. The manifest's `location` is honest

- If the manifest declares `"location": "cloud"`, the source genuinely satisfies
  the eligibility rule — transport is `feed` / `api` / `scrape`, it does not need
  a browser, and its schedule is not `on demand` — **and** every config-derived
  URL it fetches goes through the shared helpers (item 1). Anything that needs a
  real browser, on-disk files, or the user's own network is `"location":
  "client"`.

## What the gates enforce, and what only a reviewer can

`bun run check` (Biome, ESLint with SonarJS + Unicorn, `tsc`) and
`bun run validate` catch some of the checklist mechanically; the rest is the
reviewer's to verify. **No new lint rules are needed** — the table reflects the
config already in `eslint.config.mjs`.

| # | Item | Enforced by the gates? | The reviewer still confirms |
|---|------|------------------------|------------------------------|
| 1 | Network I/O via shared helpers | **No** (not lintable). `sonarjs/no-clear-text-protocols` flags plaintext `http://`, but nothing knows a URL is config-derived. | that every config-derived URL goes through a `http.mjs`/`feeds.mjs` helper, not raw `fetch`. |
| 2 | No dynamic code | **Partly.** `sonarjs/code-eval` flags `eval` and `new Function`; `sonarjs/dynamically-constructed-templates` flags built-up template strings. | a dynamically-constructed `import()` specifier (not covered by any rule). |
| 3 | No prototype / global mutation | **Partly.** `sonarjs/no-implicit-global`, `no-globals-shadowing`, and `no-global-this` cover the global side. | native-prototype mutation (e.g. `Array.prototype.foo = …`) — no active rule catches it. |
| 4 | No timing-based cleverness | **No** (not lintable). | all of it. |
| 5 | Config holds no secrets | **Adjacent.** `sonarjs/no-hardcoded-secrets` / `-passwords` / `-ip` flag secrets hardcoded in the adapter code. | that the manifest `config` schema declares no credential-shaped field. |
| 6 | Contract discipline | **Yes** — the contract tests + `bun run validate`. | — |
| 7 | Honest `location` | **Partly** — `bun run validate` enforces the transport / browser / schedule eligibility rule. | that a `cloud` source is genuinely cloud-safe (this ties back to item 1). |

Bonus automated coverage worth knowing about, since sources parse third-party
feeds: `sonarjs/xml-parser-xxe` (XML external entities), `sonarjs/slow-regex` +
`regex-complexity` + `stateful-regex` (ReDoS in feed-parsing regexes), and
`sonarjs/no-unsafe-unzip`. These run on every `.mjs` source automatically.

## The bundle is the audited artifact

The set of sources that run in Trove's cloud is compiled from a **pinned commit**
of this repository. The change that advances that pin regenerates the compiled
bundle, and its diff shows exactly the adapter code that will run — so **what
runs in the cloud is exactly what was reviewed here.** Review the source PR and,
when the pin advances, review the generated bundle diff alongside it.
