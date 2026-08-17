import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

// `bun run lint:sonar` is the second opinion behind Biome: sonarjs and unicorn
// at their recommended presets, looking for correctness and complexity rather
// than formatting. Both presets are opinionated, and a handful of their rules
// are wrong about these repos rather than about the code — those are turned off
// below, each with the reason. Everything else is expected to stay at zero.
//
// THIS FILE IS SHARED, BYTE FOR BYTE, between `trove-integrations` and
// `trove-matt-helm`. The two catalogs meet the same platform and are written to
// the same conventions, so a rule that is right about one is right about the
// other: they should be wrong in the same ways or in neither. Change it in one
// repo and copy it to the other in the same pass — the plugin versions in
// `package.json` are pinned to match for the same reason. They drifted once
// (unicorn 63 against unicorn 73), and the older repo read as clean while the
// newer one carried 129 findings that the older one simply was not looking for.

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      // Deliberately malformed sources, used to test the harness's validation.
      'test/fixtures/**',
    ],
  },
  { ...sonarjs.configs.recommended, files: ['**/*.mjs'] },
  { ...unicorn.configs.recommended, files: ['**/*.mjs'] },
  {
    files: ['**/*.mjs'],
    rules: {
      // Added in unicorn 73, and it rewrites `/** One line. */` into a
      // three-line block with no leading `*` — which is not JSDoc and is not
      // the style every other file in these repos uses. Its autofix mangled 109
      // comments across the toolkits on the first run. The house convention
      // wins over a new default.
      'unicorn/single-line-block-comment-style': 'off',

      // Every toolkit here wraps a JSON API, and `null` is a value those APIs
      // send. Fixtures have to reproduce it verbatim or they stop being
      // recordings of the wire, structured results have to emit it or they
      // stop round-tripping through JSON, and the two are meaningfully
      // different in a source: `null` is "the source answered, and the
      // answer is nothing", `undefined` is "nobody asked". Collapsing them
      // would erase a distinction the tools are built to report.
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

      // Fixture builders compose: `ok(rss(rssItem({ title: 'A' })))` is one
      // recorded response spelled in the vocabulary of the format, and
      // `feed([entry({ id })])` is one Atom document. The rule's limit of three
      // is right about production call chains and wrong about a test suite
      // whose whole idiom is small named builders nested to the depth of the
      // document they describe — 72 sites across the two repos, and hoisting an
      // intermediate `const` at each one makes every test longer and none of
      // them clearer. Genuine assertion plumbing —
      // `expect(String(at(mock.calls)[0]))` — reads better hoisted, and is,
      // because that was worth doing on its own merits rather than to satisfy
      // a counter.
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

      // Wants `iterator.toArray()` in place of `[...iterator]`. Iterator helpers
      // are ES2025: the runtime this repo's sources run in the cloud has them,
      // but a `location: client` source runs in JavaScriptCore inside the macOS
      // app, where they arrived much later — and the TypeScript `lib` these
      // repos compile against does not declare them either, so the rewrite is a
      // typecheck error today. Spread reaches every runtime and costs nothing.
      'unicorn/prefer-iterator-to-array': 'off',

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
      // uppercase digits. They cannot both be satisfied, and `bun run lint`
      // (Biome) is the gate that runs first, so Biome wins.
      'unicorn/number-literal-case': 'off',
    },
  },
  {
    // Test-only relaxations. Each of these is a rule that is right about
    // production code and wrong about the way these tests are written.
    // The fixture modules are test support, not production code: they are
    // imported only from tests, and `sources/lib/feed-fixtures.mjs` /
    // `sources/lib/test-fixtures.mjs` are where the `globalThis.fetch` stub
    // lives for every source suite that needs one.
    files: [
      '**/*.test.mjs',
      'mcp/lib/test-harness.mjs',
      'sources/lib/feed-fixtures.mjs',
      'sources/lib/test-fixtures.mjs',
    ],
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
    // The SHA-256 constant tables are transcribed from FIPS 180-4, eight
    // 32-bit words per line exactly as the standard prints them. Byte-grouping
    // them — `0x428a2f98` → `0x42_8a_2f_98` — makes them unreadable against the
    // source document, and the reflow that follows breaks the eight-per-line
    // layout that is how a reader checks the transcription at all. The rule is
    // right about `120000`; it is wrong about a published table.
    files: ['sources/lib/sha256.mjs'],
    rules: { 'unicorn/numeric-separators-style': 'off' },
  },
];
