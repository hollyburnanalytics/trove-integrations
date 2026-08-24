import tsParser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

// `bun run lint:sonar` is the second opinion behind Biome: sonarjs and unicorn
// at their recommended presets, looking for correctness and complexity rather
// than formatting. Both presets are opinionated, and a handful of their rules
// are wrong about these repos rather than about the code — those are turned off
// below, each with the reason. Everything else is expected to stay at zero.
// The twenty-nine rules that used to sit here as "deferred, not settled" were
// worked off rather than argued away: twenty-four are gone, four are held only
// until `trove-matt-helm` finishes them, and exactly one — `prefer-number-
// coercion` — was argued and accepted. All five are already at zero in
// `trove-integrations`, which is why their counts below read `(0 + n)`.
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

      // A schema IS a tree of calls. `z.array(z.object({ values: z.array(
      // z.union([z.number(), z.string(), z.null()])) }))` is one shape written
      // once, and every tool's argument and result contract is spelled that
      // way — 2,412 sites here, 86 of the 91 files production rather than
      // tests. The limit of three cannot be met without hoisting a named
      // constant for each interior node, which would scatter one schema over a
      // dozen single-use bindings and put the shape back together only in the
      // reader's head. (An earlier note here blamed test fixture builders. It
      // was measured wrong: they are 5 of the 91 files.)
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

      // One regex here scores 21 against a limit of 20: `ISO_DATE` in
      // `taddy/params.ts`, which accepts a bare `YYYY-MM-DD` or a full ISO
      // instant because Taddy's callers send both. It is exactly as complex as
      // the format it mirrors, and splitting it in two moves the complexity
      // into the code that joins them back up. (The other catalog carries the
      // same rule off for its own publisher-shaped patterns.)
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
      // type, so an unexpected parameter is a compile error. All 21 sites left
      // here are named unary renderers — `rows.map(toEntity)` — and every one
      // was checked for a second parameter.
      'unicorn/no-array-callback-reference': 'off',

      // Wants `for…of` over the string. The one site walks a Gutenberg book by
      // *code unit*, recording each offset so `get_excerpt` re-reads the match
      // at its true position; `for…of` iterates code points, moving every
      // offset in any book with an astral character.
      'unicorn/no-for-loop': 'off',

      // Type-blind, and these repos compare ISO date strings as often as
      // numbers: `row.publishedAt > newest` picks the newest model run, and
      // `Math.max` on those strings is `NaN`. Zero sites remain in this
      // catalog; the line stays because the file is shared and the other one
      // still has them.
      'unicorn/prefer-math-min-max': 'off',

      // Reads `Number.parseInt(String(x), 10)` as a number being truncated. It
      // is not: `x` is an `unknown` from a remote payload and `parseInt` is
      // there for its leniency about what follows the digits, where `Math.trunc`
      // returns `NaN`. Zero sites remain in this catalog — the guards were
      // written out under `prefer-number-coercion` — and the line stays only
      // because the file is shared with the other one.
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

      // Biome's formatter normalises hex literals to lowercase; this rule wants
      // uppercase digits. They cannot both be satisfied — writing `0xFE_FF` in
      // `owid/csv.ts` makes `biome check` fail on formatting — and `bun run
      // lint` (Biome) is the gate that runs first, so Biome wins.
      'unicorn/number-literal-case': 'off',
    },
  },
  {
    // ---- Still open in the other catalog (task #170) ----
    //
    // Every one of these is at ZERO in `trove-integrations`: the sites were
    // read and rewritten one at a time, not swept. They stay switched off
    // because this file governs both catalogs and `trove-matt-helm` has not
    // finished. Counts are `(trove-integrations + trove-matt-helm)`; retire a
    // line when the second figure reaches zero too.
    //
    // The first three are ONE IDIOM SEEN FROM THREE ANGLES. A tool's text
    // output written as a single expression, with each optional clause inline
    // as `${x ? ` — ${x}` : ''}`, is simultaneously a nested template literal,
    // a nested conditional and a nested ternary. Retiring them means giving
    // every optional clause a name — which is the same refactor that brings
    // the oversized files under Biome's `noExcessiveLinesPerFile`. Done as a
    // standalone rename pass it would be thrown away, so they land with the
    // file splits. (This catalog did the rename pass first, hoisting each
    // clause to a local `const`; that is the precedent, not a second idiom.)
    files: SOURCES,
    rules: {
      'sonarjs/no-nested-template-literals': 'off', // (0 + 261)
      'unicorn/consistent-boolean-name': 'off', //      (0 + 120)
      'sonarjs/no-nested-conditional': 'off', //         (0 + 76)
      'unicorn/no-nested-ternary': 'off', //             (0 + 35)

      // Accepted, not deferred — the one rule that is wrong rather than
      // unfinished. Its rewrite is semantic, not mechanical: `Number('')` is
      // `0` where `Number.parseInt('')` is `NaN`, and these scrapers read
      // blank cells on every request, so "the publisher reported nothing"
      // would start arriving as a reported zero. `Number('750 mL')` is `NaN`
      // where `parseFloat` gives `750`, and BC Liquor prints volumes that way.
      // The plugin ships suggestions and no autofix, which is its own authors
      // agreeing it cannot be applied blind. `trove-integrations` is at zero
      // because each of its fourteen sites was read: every one was already
      // digit-constrained, or was made stricter on purpose.
      'unicorn/prefer-number-coercion': 'off', //        (0 + 25)
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
