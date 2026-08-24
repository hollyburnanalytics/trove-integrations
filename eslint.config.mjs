import tsParser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

// `bun run lint:sonar` is the second opinion behind Biome: sonarjs and unicorn
// at their recommended presets, looking for correctness and complexity rather
// than formatting. Both presets are opinionated, and a handful of their rules
// are wrong about these repos rather than about the code — those are turned off
// below, each with the reason. Everything else is expected to stay at zero.
// The twenty-nine that once sat here as "deferred, not settled" were worked off
// rather than argued away: twenty-five are gone, three remain — the render-idiom
// cluster, landing with the file splits — and one, `prefer-number-coercion`, was
// argued and accepted. `trove-integrations` is already at zero on all four.
//
// THIS FILE IS SHARED, BYTE FOR BYTE, between `trove-integrations` and
// `trove-matt-helm`. The two catalogs meet the same platform and are written to
// the same conventions, so a rule that is right about one is right about the
// other: they should be wrong in the same ways or in neither. Change it in one
// repo and copy it to the other in the same pass — the plugin versions in
// `package.json` are pinned to match for the same reason. They drifted once
// (unicorn 63 against unicorn 73), and the older repo read as clean while the
// newer one carried 129 findings that the older one simply was not looking for.

// Every file these repos ship, in both spellings. The catalogs are mid-port
// from `.mjs` to `.ts`, and for a while both will exist; naming the two
// together is what stops a file leaving the gate simply by being renamed.
const SOURCES = ['**/*.mjs', '**/*.ts'];

// Tests, plus the two fixture modules that are test support rather than
// production code — `sources/lib/test-fixtures` holds the `globalThis.fetch`
// stub every source suite uses, and `mcp/lib/test-harness` the toolkit
// equivalent. `mcp/lib/xlsx-fixture` exists in one catalog only; a glob that
// matches nothing is inert, and naming it here keeps the file identical.
const TESTS = [
  '**/*.test.mjs',
  '**/*.test.ts',
  'mcp/lib/test-harness.mjs',
  'mcp/lib/test-harness.ts',
  'mcp/lib/xlsx-fixture.mjs',
  'mcp/lib/xlsx-fixture.ts',
  'sources/lib/test-fixtures.mjs',
  'sources/lib/test-fixtures.ts',
];

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      // Deliberately malformed sources, used to test the harness's validation.
      'test/fixtures/**',
    ],
  },
  {
    // sonarjs and unicorn are both parser-agnostic rule sets, but ESLint's
    // default parser only reads JavaScript, so every `.ts` file used to fail
    // with "Parsing error: Unexpected token" and was quietly excluded from the
    // gate. `@typescript-eslint/parser` is here for that and nothing else — no
    // typescript-eslint rules are enabled, and no `projectService`, so the run
    // stays syntax-only and as fast as it was.
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, parserOptions: { sourceType: 'module' } },
  },
  { ...sonarjs.configs.recommended, files: SOURCES },
  { ...unicorn.configs.recommended, files: SOURCES },
  {
    files: SOURCES,
    rules: {
      // Added in unicorn 73, and it rewrites `/** One line. */` into a
      // three-line block with no leading `*` — which is not JSDoc and is not
      // the style every other file in these repos uses. Its autofix mangled 109
      // comments across the toolkits on the first run. The house convention
      // wins over a new default.
      'unicorn/single-line-block-comment-style': 'off',

      // Every toolkit here wraps a JSON API, and `null` is a value those APIs
      // send. Fixtures have to reproduce it verbatim or they stop being
      // recordings of the wire, structured results have to emit it or they stop
      // round-tripping through JSON, and the two differ in a source: `null` is
      // "the source answered, and the answer is nothing", `undefined` is
      // "nobody asked". Collapsing them erases a distinction the tools report.
      'unicorn/no-null': 'off',

      // The same argument as `no-null`, for the same fixtures. arXiv's Atom
      // feed really emits `http://arxiv.org/abs/…` as a paper's id, and
      // `http://arxiv.org/schemas/atom` as a namespace; Daring Fireball really
      // publishes `http://df4.us/…` shorturls. A namespace URI is an
      // identifier, not an endpoint — there is nothing to upgrade — and
      // "fixing" the recorded ids would mean the parser is no longer tested
      // against what the publisher sends. Live request URLs are HTTPS, and
      // `sources/lib` refuses plain HTTP at the fetch seam, which is where that
      // belongs.
      'unicorn/prefer-https': 'off',

      // A schema IS a tree of calls, and every tool's argument and result
      // contract is one: `z.array(z.object({ v: z.array(z.union([…])) }))`.
      // 8,396 sites across the two catalogs, 165 of the 173 files production
      // rather than tests. The limit of three cannot be met without a named
      // constant per interior node, scattering one shape over a dozen
      // single-use bindings that the reader must reassemble. (An earlier note
      // blamed test fixture builders and counted 72. Both were measured
      // wrong.)
      'unicorn/max-nested-calls': 'off',

      // Flags every `.sort()`/`.toSorted()` without a comparator, because it
      // cannot see element types in plain JS. All of these repos' call sites
      // sort strings — tool names, schema keys, MLS numbers, ISO dates — where
      // the default lexicographic comparator is the correct one. A comparator
      // added only to satisfy the rule would be noise at every site.
      'unicorn/require-array-sort-compare': 'off',

      // Wants `params` → `parameters`, `res` → `response`, `i` → `index`,
      // `ctx` → `context`. These abbreviations are used throughout the repos
      // and in the APIs being wrapped. The rule's own suggestions argue against
      // it: it asks for `index_` where `index` is taken, and for `doc` →
      // `document` in scrapers where `document` is the browser global in scope.
      'unicorn/name-replacements': 'off',

      // A module-level `let` assigned from inside a function is how every memo
      // and cached handle in these repos is written — the YouTube visitor-data
      // token, the council-site cookie jar. That is the design, not a slip.
      'unicorn/no-top-level-assignment-in-function': 'off',

      // `await fetchThing().catch(() => fallback)` is one expression with one
      // fallback. The try/catch rewrite the rule wants needs a `let` and four
      // extra lines at each site, all of them on error paths that already
      // carry a comment explaining why the failure is being swallowed.
      'unicorn/prefer-await': 'off',

      // The callbacks passed to Playwright's `page.evaluate()` are serialised
      // and run inside the browser, where `document` and `window` are exactly
      // the globals the rule reports as undefined.
      'unicorn/isolated-functions': 'off',

      // Wants `.getHTML()`/`.setHTML()` in place of `.innerHTML`. Those are
      // browser DOM methods, and every "element" in these repos is a
      // node-html-parser `HTMLElement`, which has `innerHTML` and neither of
      // them. The rule's autofix is not a style change here: it rewrote two
      // call sites into `root.getHTML()`, which is `undefined` at runtime, and
      // seven tests failed on the spot.
      'unicorn/prefer-dom-node-html-methods': 'off',

      // The same argument as `prefer-https`: `http://gedcomx.org/Forwarded` is a
      // GEDCOM X *identifier*, the string FamilySearch stamps on a forwarded
      // person record. Nothing is fetched and there is nothing to upgrade —
      // rewriting it to `https` would stop the comparison matching.
      'sonarjs/no-clear-text-protocols': 'off',

      // Biome already owns this (`noUnusedVariables`, error) and honours the `_`
      // prefix, which is how the object-rest omit idiom — `const { programs:
      // _programs, ...rest } = charity` — drops a key without naming the others.
      // sonarjs ships a second copy that takes no options, so only one can win,
      // and it is the one that can be configured to the house convention.
      'sonarjs/no-unused-vars': 'off',

      // Reads a mutated accumulator returned from two places as "always returns
      // the same value". `tallyPeriodEnds` returns its tally early on hitting
      // the sample cap and again at the end: same object, and its contents are
      // the answer. Satisfying the rule means copying it for no reason.
      'sonarjs/no-invariant-returns': 'off',

      // A documented alias — `type FiscalYear = number` — is vocabulary, and the
      // JSDoc on it is the documentation; inlining `number` at every use loses
      // both. Where an alias must be *enforced* these repos brand it
      // (`BusinessNumber`); where it need only be *read*, plain is right.
      'sonarjs/redundant-type-aliases': 'off',

      // Three regexes across the catalogs score 21 to 30 against a limit of 20:
      // an ISO-8601 date that takes a bare `YYYY-MM-DD` or a full instant, a
      // price cell in Ship & Bunker's markup, the ways a T3010 spells "total
      // gifts". Each is exactly as complex as the format it mirrors, and
      // splitting one moves the complexity into the code that rejoins them.
      'sonarjs/regex-complexity': 'off',

      // Wants `Object.hasOwn(obj, key)` in place of `obj[key] ? … : …`. Under
      // `noUncheckedIndexedAccess` — set by both tsconfigs — `obj[key]` is
      // already `T | undefined` and the truthiness check is what narrows it.
      // `Object.hasOwn` does not narrow, so every rewritten site would need a
      // non-null assertion: a check the compiler understands, traded for one it
      // does not.
      'unicorn/no-computed-property-existence-check': 'off',

      // Right about JavaScript, redundant here. It exists because
      // `['1','2'].map(parseInt)` passes the index as a radix; in strict
      // TypeScript the callee's signature is checked against `map`'s callback
      // type, so an unexpected parameter is a compile error. All 85 sites — 21
      // in `trove-integrations`, 64 here — are named unary renderers,
      // `rows.map(toEntity)`, each checked for a second parameter.
      'unicorn/no-array-callback-reference': 'off',

      // Wants `for…of` over the string. The one site walks a Gutenberg book by
      // *code unit*, recording each offset so `get_excerpt` re-reads the match
      // at its true position; `for…of` iterates code points, moving every
      // offset in any book with an astral character.
      'unicorn/no-for-loop': 'off',

      // Type-blind, and these repos compare ISO date strings as often as
      // numbers: `row.publishedAt > newest ? …` picks the newest model run, and
      // `Math.max` on those strings is `NaN`. The genuinely numeric sites were
      // rewritten.
      'unicorn/prefer-math-min-max': 'off',

      // Reads `Number.parseInt(String(x), 10)` as a number being truncated. It
      // is not: `x` is an `unknown` from a remote payload and `parseInt` is
      // there for its leniency about what follows the digits, where `Math.trunc`
      // returns `NaN`.
      'unicorn/prefer-math-trunc': 'off',

      // Wants `subtype` for `subType`. `AccountSubType` is QuickBooks' own field
      // name and the local mirrors it — `name-replacements` again, one compound
      // word on.
      'unicorn/consistent-compound-words': 'off',

      // `taddy/enums.ts` imports the three vocabularies for its own lookup
      // tables *and* republishes them. `export…from` cannot do both, so the
      // rule buys a second statement naming a module already imported.
      'unicorn/prefer-export-from': 'off',

      // Wants `iterator.toArray()` in place of `[...iterator]`. Iterator helpers
      // are ES2025: the runtime this repo's sources run in the cloud has them,
      // but a `location: client` source runs in JavaScriptCore inside the macOS
      // app, where they arrived much later — and the TypeScript `lib` these
      // repos compile against does not declare them either, so the rewrite is a
      // typecheck error today. Spread reaches every runtime and costs nothing.
      'unicorn/prefer-iterator-to-array': 'off',
      'unicorn/prefer-iterator-helpers': 'off',

      // Kept, with one arm switched off. Flagging `return undefined` and
      // `let x = undefined` is right. Rewriting an arrow BODY is not: it turns
      // `.catch(() => undefined)` into `.catch(() => {})`, whose type is `void`
      // rather than `undefined` — a typecheck error in a `checkJs` repo, and a
      // line that now reads as an empty block instead of "and the failure means
      // no value". The argument arm stays on, and earned its place: it found
      // three functions whose parameters were declared required and were being
      // handed an explicit `undefined` at every optional call site.
      'unicorn/no-useless-undefined': ['error', { checkArrowFunctionBody: false }],

      // Biome's formatter normalises hex to lowercase; this rule wants upper.
      // They cannot both be satisfied — `0xFE_FF` in `owid/csv.ts` makes
      // `biome check` fail on formatting — and Biome runs first, so Biome wins.
      'unicorn/number-literal-case': 'off',

      // Reads `Number.parseInt(x, 10)` and `Number.parseFloat(x)` as long-hand
      // for `Number(x)`. They are different functions, and both differences are
      // things these repos do all day. `Number('')` is 0 where `parseInt('')`
      // is NaN — every scraper reads cells that are sometimes blank, and "the
      // publisher reported nothing" arriving as a reported zero is the failure
      // mode the comments here keep warning about. `Number('750 mL')` is NaN
      // where `parseFloat` is 750 — BC Liquor prints volumes that way. That
      // leniency is why the parse family is called at all; sites wanting
      // whole-string coercion already say `Number(...)`. Same argument as
      // `prefer-math-trunc` above; the plugin agrees, and offers no autofix.
      'unicorn/prefer-number-coercion': 'off',
    },
  },
  {
    // ---- Deferred, not settled (task #170) ----
    //
    // What is left of a block that held twenty-nine rules. These three are one
    // idiom from three angles: a tool's text output is one expression, its
    // optional clauses inline as `${x ? `…` : ''}`. Naming every clause is the
    // same refactor that brings the oversized files under
    // `noExcessiveLinesPerFile` — `charitydata/extension.ts` was done that way
    // and lost all 34 of its findings to seven named row renderers — so the
    // rest should land with those splits rather than ahead of them. Counts are
    // `trove-matt-helm` on this commit; retire a line at zero in BOTH repos.
    files: SOURCES,
    rules: {
      'sonarjs/no-nested-template-literals': 'off', // 227 — the render idiom: one sentence, one expression
      'sonarjs/no-nested-conditional': 'off', //        74 — nested ternaries, mostly inside the render idiom
      'unicorn/no-nested-ternary': 'off', //            35 — a subset of no-nested-conditional
    },
  },
  {
    // Test-only relaxations. Each of these is a rule that is right about
    // production code and wrong about the way these tests are written.
    files: TESTS,
    rules: {
      // Test helpers — fake responders, fixture builders — are defined in the
      // `describe` that uses them, next to the assertions that explain them.
      // Hoisting them to module scope to satisfy the rule would spread each
      // test's setup across the file.
      'unicorn/consistent-function-scoping': 'off',

      // Stubbing `globalThis.fetch` around a call and restoring it in `finally`
      // is how every source and toolkit here is tested without a network.
      'unicorn/no-global-object-property-assignment': 'off',

      // These assertions pin an exact value that a fixture states or a tool
      // rounds to two decimals — 105.7 tonnes as the CGC printed it, 5.62 hours
      // as the server computed it. Asserting a range instead would stop the
      // test from catching the arithmetic drifting.
      'sonarjs/no-floating-point-equality': 'off',

      // `error.name = 'TimeoutError'` is how a real `AbortSignal.timeout()`
      // rejection is reproduced in Node without reaching for DOMException.
      'unicorn/no-error-property-assignment': 'off',

      // The hand-built DOM stub in the LinkedIn tests uses object method
      // shorthand to mimic `Element`, and those methods need `this` to walk
      // the node they were called on.
      'unicorn/no-this-outside-of-class': 'off',
    },
  },
  {
    // `scripts/` and `bin/` are the operator command line — run by hand, from a
    // terminal, by the person who owns the catalog. Two rules that are right
    // about a Worker are wrong about that.
    files: ['scripts/**', 'bin/**'],
    rules: {
      // "Only use `process.exit()` in CLI apps." These are CLI apps: a build
      // script that exits 1 on a bad argument is reporting a status to the
      // shell, and throwing would print a stack trace instead.
      'unicorn/no-process-exit': 'off',

      // Flags `spawnSync('trove', …)` for resolving a binary through `PATH`.
      // The binary is the operator's own `trove` CLI, on the operator's own
      // machine; pinning an absolute path would break the moment they moved it.
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  {
    // `curl` is reached through PATH deliberately, and the rule's objection —
    // that a PATH lookup can be hijacked — does not apply here: the arguments
    // are an array (no shell), and every URL is host-allowlisted via
    // `assertAllowedUrl`. curl, not `fetch`, because the council site answers
    // only to its TLS fingerprint.
    files: ['sources/wv-council-meetings/curl-transport.ts'],
    rules: { 'sonarjs/no-os-command-from-path': 'off' },
  },
  {
    // `Math.random()` here is jitter on a retry backoff — it spreads a fleet of
    // channel syncs across the hour so they do not all wake together. It picks
    // no secret, id or key; a stronger source would buy only a slower loop. Two
    // paths, named not globbed: `backoffMs` carries the jitter and moves when
    // the source is split, and a glob would cover the next file unread.
    files: ['sources/youtube-videos/bot-wall.ts', 'sources/youtube-videos/extension.ts'],
    rules: { 'sonarjs/pseudo-random': 'off' },
  },
  {
    // The SHA-256 constant tables are transcribed from FIPS 180-4, eight
    // 32-bit words per line exactly as the standard prints them. Byte-grouping
    // them — `0x428a2f98` → `0x42_8a_2f_98` — makes them unreadable against the
    // source document, and the reflow that follows breaks the eight-per-line
    // layout that is how a reader checks the transcription at all. The rule is
    // right about `120000`; it is wrong about a published table.
    files: ['sources/lib/sha256.ts'],
    rules: { 'unicorn/numeric-separators-style': 'off' },
  },
];
