# HTML → Markdown for feed bodies

`htmlToText()` turns the HTML inside an RSS/Atom/JSON-Feed entry into the
Markdown that Trove stores. This document is what it supports, what it does not,
how it fails, and why it is built the way it is.

| Module | Job |
|---|---|
| `html-markdown.mjs` | Walks the parsed tree and decides what structure survives |
| `html-prepare.mjs` | Peels entity layers, unwraps CDATA, tidies the assembled output |
| `markdown-sink.mjs` | Collects fragments; knows whether it is at the start of a line |
| `markdown-emit.mjs` | Decides what bytes are safe to emit for a given fragment |

---

## The one thing to understand first

**Parsing is not the risky half.** HTML is parsed by
[`node-html-parser`](https://github.com/taoqf/node-html-parser), a real parser —
there is no regex tag-matching anywhere in this path. Everything below concerns
the *second* half: turning a correct DOM into Markdown.

**The output must not merely parse — it must parse as what the HTML meant.**
Trove's ingest gate (`normalizeMarkdown` in the backend) parses every submitted
body to an AST and **stores its own re-serialization of that AST, not our bytes**.
Three consequences shape every decision here:

1. **Cosmetic choices do not matter.** Bullet character, `*` versus `_`, blank
   line counts — all canonicalized downstream. Do not spend effort there.
2. **Structure matters absolutely.** If our output parses as a *different tree*,
   the backend faithfully canonicalizes the wrong tree. Nothing downstream can
   detect it, because the stored body is now well-formed Markdown that simply
   says something else.
3. **A malformed emit stops a feed, not a document.** A gate rejection is a
   per-document error that holds the feed's cursor — deliberately, so corruption
   is loud. One publisher's stray tag can halt a whole feed.

That is why the guards below are guards and not polish.

---

## Supported

| HTML | Markdown | Notes |
|---|---|---|
| `<h1>`–`<h6>` | `#`–`######` | Empty headings dropped, not emitted bare |
| `<p>`, `<div>`, `<section>`, … | blank line / line break | |
| `<a href>` | `[text](url)` | Self-linking URLs collapse to `<autolink>` |
| `<ul>` / `<ol>` | `-` / `1.` | Numbering, `start=`, and nesting depth preserved |
| `<blockquote>` | `> ` on **every** line | Nests correctly |
| `<pre>` | fenced block | Fence widened past any fence inside |
| `<code>` | `` `span` `` | Fence widened past any backtick inside |
| `<table>` | GFM table | Ragged rows padded; pipes escaped |
| `<strong>`/`<b>`, `<em>`/`<i>` | `**`, `*` | Adjacent same-type spans merged |
| `<img alt>` | `[Image: alt]` | Dropped entirely when `alt` is empty |
| `<br>`, `<hr>` | line break, blank line | |
| Entities | decoded | Repeatedly, until markup is revealed (max 3 passes) |

**Dropped whole:** `script`, `style`, `noscript`, `template`, `iframe`, `svg`,
`head`, `form`, `button`, `input`, `select`, `option`, `audio`, `video`,
`source`. These are chrome or payload; none carries prose.

---

## Not supported — known degradations

These are deliberate. Each loses information, and each is listed so nobody has to
rediscover it from a puzzling document.

| Input | Result | Why it is acceptable |
|---|---|---|
| `<sup>2</sup>`, `<sub>2</sub>` | `x2`, `H2O` | **Genuinely lossy and silently wrong** — `x²` and `x2` are different values. Markdown has no native super/subscript. The mitigation is that Trove's corpus is prose, not formulae; scientific sources should not use this path. |
| `<del>`, `<ins>`, `<mark>`, `<u>` | plain text | Emphasis markers are inflationary — every one is another chance to change the parse. GFM `~~` would be available for `<del>` if a source needed it. |
| `<dl>`/`<dt>`/`<dd>` | paragraph lines | The term/definition relationship is lost. Rare in feeds. |
| `<figure>`/`<figcaption>` | caption as a line | The caption survives; its binding to the image does not. |
| Nested tables | inner cells become space-separated text inside the outer cell | GFM tables cannot nest. Emitting the inner table's Markdown into a cell escapes its pipes and produces unreadable noise. |
| Column/row spans | ignored; cells laid out in document order | A spanning cell appears once, in its first position. |
| Footnote markup | plain text | Not attempted. |
| `<table>` used for layout | rendered as a table | We cannot tell layout tables from data tables. A GFM table is still better than welded cells. |
| Definition of "safe" URL | `javascript:`, `data:`, `vbscript:` etc. dropped to link text | See below. Deliberate. |

---

## Failure modes

**Nothing here throws.** `htmlToText` returned a value for all 35,253 corpus
bodies, including malformed and hostile ones. The failure modes are quieter:

| Mode | Behaviour |
|---|---|
| Malformed HTML (unclosed, mis-nested) | The parser recovers; output is whatever tree it built. Not detectable here. |
| Unknown tags | Treated as inline; children still rendered. Content is never lost to an unrecognized tag. |
| Orphaned `<li>`/`<tr>`/`<td>` (fragment cut mid-structure) | Rendered one per line. No marker or grid, but no welding. |
| Deep nesting | Recursion is depth-first and unbounded. 60 levels tested; a pathological feed could in principle exhaust the stack. |
| Very large bodies | No size cap. Cost is linear in input. |
| Text that looks like Markdown | Escaped when position-significant (see below). |
| Structure with no Markdown equivalent | Degraded per the table above — silently. |

### The one class we cannot fix here

**Long base64-like URLs.** Google News feeds use redirect URLs of ~500 base64
characters. The backend's `checkEncodedJunk` scans the raw text *before* parsing,
so it cannot tell a link destination from a leaked binary blob, and rejects the
body. **This is the only remaining source of gate rejections in the corpus — 13
of 35,253 — and it is a backend issue, not a converter one.** The fix belongs in
`checkEncodedJunk` (exempt link destinations), not here.

---

## Design deductions

Each of these was forced by evidence, not chosen up front.

**1. Escaping is positional, so the sink has to know where it is.**
`#` opening a line is a heading; `#` mid-sentence is a `#`. A plain array of
string fragments cannot answer "am I at the start of a line?" without re-scanning
everything already emitted — so fragments go through `markdown-sink.mjs`, which
tracks one character of state. That single bit is why the sink is an object.

**2. Inline contexts must be flattened, not escaped.**
Link text and table cells cannot hold block structure. A `<h4>` inside an `<a>`
is legal HTML (77 corpus bodies do it) and emitting it literally gives
`[#### Title](url)` — a link whose text starts with hashes. Escaping would
preserve the wrong thing; flattening preserves the words.

**3. Fences must be measured, never fixed.**
A single backtick is wrong whenever the code contains one — 621 corpus bodies
have backticks inside code (JavaScript template literals, mostly). CommonMark's
own rule applies: a fence longer than the longest run inside.

**4. Never weld two strings that were separate in the source.**
`<td>Launch date</td><td>September 2026</td>` becoming `Launch dateSeptember 2026`
is not a formatting loss — it is a **fabricated string that never appeared in the
source**. Any structure whose removal joins two text runs must insert a separator.
This is the strongest rule here; it outranks fidelity to any particular tag.

**5. Refuse active URL schemes, degrade to the text.**
Stored bodies are rendered in the web app and fed to models, and a `data:` URI
carries its payload inline. The words belong to the source; only the target is
refused.

**6. Prefer a code-point predicate to a regex of invisible characters.**
`stripControlCharacters` names its ranges instead of embedding literal control
characters in a character class — which would be unreadable in source,
unreviewable in a diff, and would need a lint suppression to say "the control
characters are the point".

**7. Do not add a mature converter — yet.**
See below. This is a live judgement, not a settled one.

---

## Why not Turndown or `rehype-remark`?

An honest accounting, because the case is closer than it looks.

**For adopting one:** both bugs found by stress-testing — a `<br>` inside link
text, and an empty `<h2>` — are ones Turndown handles by construction, after a
decade of feeds thrown at it. `rehype-remark` is better still: it produces
**mdast**, the same AST the backend gate parses to, which would make round-tripping
*structurally guaranteed* rather than merely tested. Every "our emit parses as the
wrong tree" bug in this document becomes impossible, by construction.

**Against:** this repo has **two** runtime dependencies, on purpose. Turndown
needs a DOM shim; the `rehype-remark` chain pulls in the unified ecosystem — tens
of transitive packages, in a sandboxed per-tenant runtime, reviewed by us.

**Current position:** keep the hand-rolled converter, now that it is verified
against 35,253 real bodies rather than eight fixtures. **Revisit `rehype-remark`
— not Turndown — when the maintenance cost of this file next rises**, because
sharing an AST with the gate is a structural guarantee no amount of testing here
can equal. An earlier version of this note argued the corpus had no tables; a
larger corpus refuted that. Treat the position as evidence-dependent.

---

## The corpus audit

Every count in this document comes from one procedure. Re-run it after any change
to these modules — it takes about two minutes and finds what fixtures cannot.

1. **Get feeds.** ~1,000 URLs were extracted from the public
   [`awesome-rss-feeds`](https://github.com/plenaryapp/awesome-rss-feeds) list and
   fetched concurrently; 502 returned parseable feeds (a dead feed in a public
   list is expected, not a finding).
2. **Convert.** Parse each with this repo's own `parseRSS`, convert every
   `bodyHtml` with `htmlToText`. **35,253 bodies.**
3. **Gate.** Push each result through the backend's *actual* `normalizeMarkdown`,
   bundled from `trove/src/features/ingest/format.ts` with esbuild. A local
   re-implementation would pass things production rejects.
4. **Compare shapes.** The gate returns its re-serialization. Count headings,
   list items, links, quote lines, fences and table rows on both sides. **Equal
   counts mean the parser read the tree we meant to write; a moved count is a
   real defect.** This step is what caught the misreads a pass/fail gate missed.

### Results

| | Before | After |
|---|---|---|
| Gate rejections | 239 | **13** (all the backend URL issue above) |
| Converter exceptions | 0 | 0 |
| Ordered lists losing numbering | 239 of 246 | 0 |
| Nested lists flattened | 2,417 | 0 |
| Table cells welded | 21 | 0 |
| Bodies with control characters | 403 | 0 |
| Bare list markers | 299 | 0 |
| Captions fenced as code | 65 | 0 |
| Identical round-trip | — | 23,771 (67%) |
| Cosmetic-only difference | — | 9,047 (26%) |
| Structural drift | — | 2,422 (7%), all `[a@b](mailto:a@b)` → `<a@b>` |

### What this exercise proved about method

The fixture-based tests passed throughout the period when every `<ol>` in the
corpus was losing its numbering. **A converter is only as good as the inputs it
has been shown, and hand-written fixtures agree with whatever the code already
does.** The regression tests in `html-markdown.test.mjs` are all derived from
corpus findings, and each carries the count of bodies that hit it — a shape
occurring 2,417 times is not an edge case, it is the corpus.
