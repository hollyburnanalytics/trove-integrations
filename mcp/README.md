# Trove toolkits

The **Toolkit** half of the repo (see [`../docs/taxonomy.md`](../docs/taxonomy.md)).
Every toolkit runs as a full MCP server on Trove's cloud; each subdirectory is
one — a `manifest.json`
(identity, egress allowlist, declared secrets) plus a `server.ts` built on the
`@ontrove/mcp` SDK (`defineMcpServer`, Zod input/output schemas, `ToolError`, the
`ctx` capability object). They run as sandboxed servers behind the single Trove
`/mcp` endpoint, with deny-by-default egress and per-tenant secret redemption via
`ctx.secret`.

> **SDK & toolchain note.** These servers are built on the `@ontrove/mcp` SDK
> (`defineMcpServer`, Zod schemas, `ToolError`, the `ctx` capability object) and
> deployed with the `trove` CLI. `@ontrove/mcp` is published to npm; this repo
> pins it as a dev dependency and **typechecks every `server.ts` against the
> published API in CI** (`bun run typecheck`), so the examples stay honest.

Most tools are **read-only** (`readOnlyHint: true`); `resend` is the first
**mutating** server (`send_email`). Servers reach only the public HTTP/JSON APIs
in their manifest `egress`.

## Catalog

### Knowledge & research
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `arxiv` | `search_papers`, `get_paper`, `get_paper_content`, `save_paper` | export.arxiv.org, arxiv.org, ar5iv.labs.arxiv.org | — |
| `semantic-scholar` | `search_papers`, `get_paper`, `get_paper_citations`, `get_paper_references` | api.semanticscholar.org | — |
| `openalex` | `search_works`, `search_authors` | api.openalex.org | **`OPENALEX_API_KEY`** |
| `openlibrary` | `search_books`, `get_book` | openlibrary.org | — |
| `internet-archive` | `search_archive`, `get_item` | archive.org | — |
| `gutenberg` | `search_books`, `get_book`, `search_inside`, `get_excerpt` | gutendex.com + PG mirror | — §|
| `hathitrust` | `lookup_volume` | catalog.hathitrust.org (Bibliographic API) | — ‡|
| `wikipedia` | `search_articles`, `get_article` | en.wikipedia.org | — |
| `wikidata` | `search_entities`, `get_entity` | www.wikidata.org | — |
| `oeis` | `search_sequences`, `get_sequence` | oeis.org | — |
| `pubchem` | `search_compounds`, `get_compound` | pubchem.ncbi.nlm.nih.gov (NIH/NLM) | — |
| `the-met` | `search_objects`, `get_object` | collectionapi.metmuseum.org | — |

### Government & civic
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `sec-edgar` | `get_financials`, `get_xbrl_concept`, `get_filing_document`, `insider_transactions`, `get_fund_holdings`, `get_company`, `search_filings`, `company_filings` | SEC EDGAR (efts/data/www.sec.gov) | — |
| `world-bank` | `search_indicators`, `get_indicator` | api.worldbank.org | — 🌍|
| `our-world-in-data` | `search_charts`, `search_indicators`, `get_chart_data`, `get_indicator_data`, `get_chart_metadata` | ourworldindata.org + api.ourworldindata.org + search.owid.io | — ⊕|
| `canada-open-data` | `search_datasets`, `get_dataset`, `query_dataset`, `find_organizations` | open.canada.ca (CKAN — federal + provincial) | — |
| `openparliament` | `find_mp`, `mp_speeches`, `search_bills` | api.openparliament.ca (Canada Hansard) | — |
| `dnv-permits` | `search_permits`, `suggest_addresses`, `recent_permits` | app.dnv.org (District of North Vancouver) | — |
| `orgbook-bc` | `search_entities`, `get_entity`, `get_entity_history` | orgbook.gov.bc.ca (BC Corporate Registry mirror) | — ◊|
| `bc-workers-comp-decisions` | `search_wcat_decisions`, `get_wcat_decision`, `search_review_decisions` | www.wcat.bc.ca + rdpubsearch.online.worksafebc.com | — †|

### Geo, weather & time
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `mapbox` | `isochrone`, `geocode`, `directions` | api.mapbox.com | **`MAPBOX_TOKEN`** |
| `open-meteo` | `geocode_place`, `forecast`, `historical` (back to 1940), `air_quality` | open-meteo.com | — |
| `usgs-quakes` | `recent_quakes` | earthquake.usgs.gov | — |
| `holidays` | `public_holidays`, `next_holidays` | date.nager.at | — |

### Economy & health
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `fred` | `search_series`, `get_observations` | api.stlouisfed.org (St. Louis Fed) | **`FRED_API_KEY`** 📈|
| `openfda` | `search_drug_labels`, `search_recalls` | api.fda.gov | — |

### Business ops
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `jonas-premier` | `list_companies`, `search_jobs`, `get_job_transactions`, `get_job_estimate`, `search_vendors`, `get_ap_invoices`, `get_ap_payments`, `get_gl_accounts`, `get_subcontracts`, `get_subcontract_change_orders` | api.jonas-premier.com (Premier Construction Software External API) | **`JONAS_USERNAME` + `JONAS_PASSWORD`** ¶|
| `toggl` | `check_auth`, `list_workspaces`, `get_time_entries` | api.track.toggl.com (Toggl Track API v9) | **`TOGGL_API_TOKEN`** ⏱|

### Social
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `x` | `get_user_tweets`, `get_tweet`, `get_post_replies`, `search_posts`, `count_posts`, `resolve_user`, `get_bookmarks` | api.x.com (X API v2) | **`X_BEARER_TOKEN`** (reads) · **`X_OAUTH_CLIENT_ID` + `X_OAUTH_REFRESH_TOKEN`** (+ optional `X_OAUTH_CLIENT_SECRET`) for `get_bookmarks` |

### Personal / niche
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `ebay` | `search_items`, `get_item` | api.ebay.com (Browse API) | **`EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET`** |
| `shopify-catalog` | `search_products`, `lookup_products`, `get_product` | catalog.shopify.com (UCP catalog MCP) | none |

### Actions (mutating)
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `resend` | `send_email` | api.resend.com | **`RESEND_API_KEY` + `RECIPIENT_EMAIL`** ※|
| `cal-com` | `list_event_types`, `get_available_slots`, `list_bookings`, `create_booking`, `cancel_booking` | api.cal.com (Cal.com API v2) | **`CALCOM_API_KEY`** 📅|

※ `resend` — the fleet's first **mutating** server (`send_email` is `readOnlyHint: false`, so the host confirms before sending). It's a hosted send-email server for **automated digests/notifications to yourself** — useful where only remote/hosted MCP servers are reachable (the official Resend/Postmark MCPs are local stdio). The **recipient is fixed to the owner's `RECIPIENT_EMAIL` secret** and CC/BCC are disallowed, so the tool can only ever email that one address (it can't be steered into emailing arbitrary recipients) — a deliberate safety choice for a send-capable tool. The fixed address needs no domain setup (Resend's shared `onboarding@resend.dev` sender); to send *from* your own domain, verify it in Resend and pass `from`.

🌍 `world-bank` — **global development indicators**, keyless. The same
silent-answer failures `fred` was audited for were found here and fixed, which
is the argument for auditing the rest of the fleet against the two rules at the
end of this file rather than one toolkit at a time:

- **The page was reported as the answer.** `per_page` was pinned at 120 with no
  `limit` in the schema at all, and the API's own `total`/`pages` were
  discarded. `country: "all"` for one indicator is ~17,500 rows across 265
  entities; the tool returned 120 — roughly **two** entities, starting at
  "Africa Eastern and Southern" — and reported `count: 120` with no other
  signal. Now `limit`/`page` are inputs and `total`/`truncated`/`nextPage` come
  back with every result.
- **Rows from `country: "all"` were unlabelled.** The mapping dropped each
  row's country, so a multi-entity pull returned the same year many times over
  with different values and nothing saying whose. The country now rides on each
  row whenever a response spans more than one.
- **A one-sided date range was accepted and ignored.** `if (start && end)` meant
  `start: 2010` alone was validated, dropped, and answered with the most recent
  120 points as though they were the requested range. The API rejects an
  open-ended `date=2010:`, so a missing bound is filled with a sentinel year
  instead; a reversed range is now named rather than passed on.
- **A transient upstream blip was reported as the caller's fault.** The API
  intermittently serves an HTML error page under an HTTP 200 (observed live,
  succeeding on retry); the non-JSON body fell through to "check the country and
  indicator codes", **non-retryable** — sending callers to fix codes that were
  correct. Unparseable JSON is now retryable, distinct from a genuine
  `[{message:[…]}]` rejection.

`search_indicators` matches client-side over one fetched page of the WDI
catalogue (~1,500 of 2,000 today). It now compares what it fetched against the
API's `total` and says when the page didn't hold everything, so the day the
catalogue outgrows the fetch the search stops quietly losing its tail.

📈 `fred` — **U.S. economic time-series from the St. Louis Fed**, shaped around
the fact that every way this connector can be wrong is a *confidently wrong
number*, not an error. Three upstream behaviours drove the design, each covered
by a regression test:

1. **`limit` clips the range with no signal.** Asking `LNS12300060` for
   1985→2026 at `limit=100` returns 100 observations ending in April 1993, and
   nothing in the response distinguishes that from the series ending there.
   FRED's own top-level `count` is the size of the matching set *before*
   `limit`/`offset`, so every result now reports `availableInRange` next to
   `returned`, plus `truncated` and a `nextOffset` — and the prose mirror says
   `TRUNCATED: 100 of 498 … 398 more not returned`, because some hosts render
   only the text.
2. **Seasonal adjustment is the only thing separating many hits.** `CPIAUCSL`
   and `CPIAUCNS` share a title, units *and* frequency; so do `CPILFESL`/
   `CPILFENS` and `CSUSHPISA`/`CSUSHPINSA`. Picking by ID-suffix convention is
   tribal knowledge, and picking wrong yields month-over-month "inflation" that
   is mostly seasonal noise. `seasonal_adjustment_short` is mapped onto every
   hit, spelled out in the prose, and offered as a filter (where `SA` also keeps
   `SAAR` — FRED's own `filter_variable` would drop it).
3. **Ranking is literal.** `search_rank` answers "inflation" with four
   frequencies of the same inflation-*indexed* Treasury yield and no CPI in the
   top ten. `orderBy` is exposed (`popularity` is the better prior for a broad
   concept) and `popularity` rides along on every hit so a caller can judge the
   ranking rather than trust it.

The other half is **pushing transformation upstream**. `units` (FRED's nine
transforms) and `frequency` + `aggregation_method` (server-side downsampling)
are free at the API and expensive here — rendering `OPHNFB` as a continuously
compounded annual rate otherwise means ~300 logarithms computed in-context, none
of them auditable. `frequency` only ever aggregates *down*, so an upsampling
request (`UNRATE` → daily) is refused by name before any data call, and
`get_observations` takes 1–5 ids per call so an overlay or a spread is one round
trip. Each result carries the series' title, units, applied transform and
seasonal adjustment, so a chart axis can be labelled from a single response;
an empty range answers with the series' actual coverage rather than a bare zero.
Sizing is explicit rather than silent: `format: "columnar"` returns parallel
`dates[]`/`values[]` (dates are **listed, not derived** — FRED's "Daily" series
are business-daily, so a date axis reconstructed from start+frequency would
mislabel every point after the first weekend), and a pull over 2,000 points is
refused with the limit to use instead of being quietly shrunk.

⊕ `our-world-in-data` — an **independent client for Our World in Data's public
APIs**, not affiliated with or endorsed by Our World in Data or Global Change
Data Lab. The name is used descriptively, to say which API this talks to; no
OWID logo or branding is used, and nothing here reproduces their Grapher
software, which is separately licensed and requires written permission to reuse.

**The numbers behind OWID's charts**, keyless: keyword
search over ~13k charts, semantic (embedding) search over the indicator
catalogue, tidy `{entity, time, value}` rows either **by chart slug** or **by
indicator id**, and the metadata behind it — units, definitions, processing
notes, coverage, update schedule, and full provenance. Read-only; nothing is
written to the knowledge base.

The two data tools exist because the two lookups are genuinely different.
`get_chart_data` returns every column a chart plots, filtered through grapher
(where `time` *snaps* to the nearest available point). `get_indicator_data`
returns one named variable by id, and its year filter really filters. Most
indicators appear on **no chart at all**, so without the second tool
`search_indicators` is a dead end: you find exactly the variable you wanted and
have no way to read it.

**The redistribution gate is enforced here, not just relayed.** OWID refuses
restricted data on the chart CSV (403) and omits the table from the catalog
(404) — but the indicator data endpoint serves it anyway. `get_indicator_data`
therefore checks `nonRedistributable` on the metadata *before* fetching any
observations and raises the same refusal, so this toolkit is not the one way
around a licence its own other tools respect.

**Licensing is an output, not a footnote.** Most OWID data is third-party (WHO,
UN, World Bank, Defra, IHME…) under the *original provider's* terms, so every
data result carries `citationLong` — the string naming every upstream producer —
and `get_chart_metadata` reports each source's licence by name and URL. Where
OWID is not permitted to redistribute at all, the CSV endpoint answers **403**
with the reason, which is surfaced verbatim rather than as a generic failure;
metadata still works for those charts, so the licence remains inspectable.

Four upstream behaviours drove the design, each of which fails **silently with
an HTTP 200** and is covered by a regression test:

1. **The entity selector splits on `~` — but on `+`/space when no `~` is
   present.** So `country=United States` returns a header row and no data. A
   leading `~` is always emitted, and query strings encode spaces as `%20`
   rather than `+`, so no value ever contains the other separator.
2. **`csvType=filtered` means "what the chart is showing", and a map-default
   chart is showing every country** — the entity selection is not part of a
   map's state. `covid-cases` asked for `World` returns 395 rows for 250
   countries; `tab=chart` returns 14 for World. Map-*only* charts ignore the
   selection regardless, so the selection is also enforced server-side after
   parsing: the tool never presents 250 countries under the one requested.
3. **The selector is case-sensitive** (`JPN` works, `jpn` returns nothing). A
   miss is repaired rather than reported: the entity list supplies the canonical
   spelling and the data is re-fetched once, so `["USA","jpn"]` returns both
   countries with a note. Anything still unmatched is named, with edit-distance
   suggestions ("United Kingdon" → "United Kingdom").
4. **`time` snaps rather than filters** — asked for `1800..1810` on a series
   starting in 1831, grapher answers with 1831. Rows outside the requested
   window are flagged instead of being relabelled. Long-run series are indexed
   in BCE years (`-10000`), which the time parsing and ordering handle as
   numbers, not text.

Sizing is deliberate: `csvType=full` is the API default and reaches megabytes
(`co2-by-source` is ~1.4 MB), so every request is `filtered`, rows are capped
(`max_rows`, default 200), the text mirror spells out at most 60 of them, and an
oversized body is refused with advice rather than parsed.

**A context window is the wrong place for a dataset**, so every result also
names where the whole thing lives: `downloads.csv` (all entities and years,
headers matching the reported `columns[].key`), `.zip`, and — per indicator —
the **Parquet table in OWID's catalog**, which DuckDB queries in place over HTTP
(`SELECT country, year, <parquetColumn> FROM '<parquetUrl>'`). `search_indicators`
passes through the upstream's own runnable SQL. Parquet URLs are suppressed for
non-redistributable indicators: OWID does not publish those tables to the catalog,
and advertising one would read as a way around the licence its CSV endpoint
refuses on purpose.

**The recurring bug shape, written down because it recurred.** Almost every
defect found in this toolkit was a *confidently wrong answer*, not a failure —
and almost all of them arrived as HTTP 200. Two generalisations earned their
keep, and both found further bugs after being named:

1. **The upstream's defaults are the unsafe path.** `csvType` defaults to the
   whole indicator; no `tab` means map semantics; no `country` means every
   entity. Every safe request here states a non-default explicitly.
2. **Nothing that can have many values may be read from the first one.** The
   first column's citation stood in for a chart drawing on four producers; the
   first indicator's entity list denied entities a later one carried; the first
   `max_indicators` decided a licence verdict for all of them. Each was found
   separately before the shape was named — then naming it turned up two more.

The corollary for the licence gate: **do not assume the upstream enforces it
consistently.** The same restricted dataset 403s on the chart CSV, 404s in the
catalog, and returns 200 with 214 KB of data on the indicator endpoint.

Two things follow from *most OWID data being third-party*. Attribution is
collected across **every** column in the result, not the first — a chart
stacking UN IGME, WHO and HYDE credits all three, because crediting one would
put the other two organisations' numbers under the wrong name. And coverage is
described from the whole selection rather than the truncated page: the CSV is
entity-major and oldest-first, so reporting the visible slice's last year once
claimed life expectancy ended in 2018.

◊ `orgbook-bc` — **verify BC-registered legal entities** in the province's public
registry (OrgBook BC, the verifiable-credential mirror of the BC Corporate
Registry): ranked name search, exact lookup by registration number (`BC…`/`FM…`/
`S…`), and the credential timeline behind a registration (name changes, business
number, Active/Historical transitions). Keyless. The API has no
lookup-by-registration-number endpoint, so `get_entity` searches the number and
then insists on an exact `source_id` match — a fuzzy near-miss is treated as
not-found, never returned as the answer. Pairs naturally with `jonas-premier`:
confirm a vendor's exact legal name and status before money moves.

¶ `jonas-premier` — **read-only window into a Premier Construction Software
(Jonas Premier) tenant**: companies → jobs → job-cost transactions & original
estimates, vendors → AP invoices & payments, GL accounts, and subcontracts with
their change orders (contract amount + builders-lien holdback %). Auth is the
vendor's documented OAuth2 *password* grant (`POST /Authenticate`, fixed client
id `Premier.ExternalAPI`) using an **API user created inside the Premier tenant**
— the SDK's declarative client-credentials block doesn't fit, so the server
hand-rolls the mint with a **per-user token cache** (one tenant's token must
never serve another) and one re-mint on 401. Quirks worth knowing: the tenant is
multi-company, so `list_companies` comes first; the AP tools require an
`apSubledgerId` that comes from a `search_vendors` result; and
`get_job_transactions` requires an updated-date range (Premier's rule — it keeps
pulls time-boxed). Write endpoints (create/pay invoices, create subcontracts) and
the Payroll module (employee PII) are deliberately not exposed.

📅 `cal-com` — **the scheduling loop end to end**: list event types → find open
slots → book, plus reading and cancelling existing bookings. Three tools are
read-only; `create_booking` and `cancel_booking` are `readOnlyHint: false`, so
the host confirms before a real calendar event is created or an attendee is
notified. Unlike `resend`, nothing is pinned to a secret — an arbitrary attendee
*is* the legitimate use of a booking tool, so host confirmation is the control
that fits. Cancellation is deliberately per-uid; there is no bulk cancel.

The v2 API is **versioned per endpoint group** via a `cal-api-version` header,
and the values really do differ — `2024-06-14` (event types), `2024-09-04`
(slots), `2026-05-01` (read bookings), `2026-02-25` (write bookings). Sending the
wrong value doesn't error; it silently serves an **older contract with a
different response shape**, so every request states its version explicitly and
the tests assert each one. Two more quirks worth knowing: an event type is named
either by numeric id *or* by `slug` + `username` (never half of the pair), and
Cal.com signals business-rule rejections — an unavailable slot, an already-cancelled
booking — as `{"status":"error"}` inside an **HTTP 200**, which the server raises
rather than reporting as an empty success.

The third quirk only shows up against a live account: `/slots` returns starts
carrying the **requested zone's offset** (`2026-07-27T09:30:00.000-07:00`), while
the booking endpoints document `start` as **UTC**. Copying a slot straight into
`create_booking` would therefore post a non-UTC instant for a UTC field, so
`bookingBody` normalises it — the slots → booking round-trip is correct whatever
zone the slots were asked for.

⏱ `toggl` — **read-only view of the caller's own Toggl Track account**, built
for the questions people actually ask it: *what did I work on this week, and how
much of it was billable to whom.* Entries come back resolved to **workspace,
project, client and tag names** — not the bare ids the API returns — plus a
per-client duration roll-up, and `period` accepts `today`/`yesterday`/`week`/
`lastWeek`/`month`/`lastMonth` alongside explicit dates.

Two design points worth knowing. **Named periods are timezone-aware**: the server
runs in UTC, so a naive "today" rolls over mid-afternoon for a Pacific user —
`time_zone` (IANA, default UTC) decides which calendar day is meant, and ranges
are always `[start, end)` to match the API. **Hydration is bulk, not per-entry**:
one `/projects`, `/tags` and `/clients` call per *referenced* workspace, then
in-memory joins, each skipped entirely when no entry needs it. Cost is bounded
per workspace no matter how many entries return — the alternative, resolving
names one entry at a time, only works behind a long-lived cache a stateless
hosted invocation doesn't have.

Rate limiting is the last trap: Toggl runs a leaky bucket at ~**1 request/second
per token per IP** and counts *every* integration sharing that token (Zapier,
Make, Timery) against the same budget, so this server can be limited through no
fault of its own. A 429 is surfaced as a **retryable** error carrying
`retryAfter` and — unlike a 401 — is never reported as "not authenticated", so a
burst never looks like a bad token. The account email is masked in output.

‡ `hathitrust` — covers the **public Bibliographic API** only: given an ISBN/OCLC/LCCN/HathiTrust id it reports holdings + per-copy access rights (Full view = readable public domain, vs Limited = search-only). Its distinctive value over Open Library / Google Books is that **rights signal** — "can I actually read this, or only search it?" — plus a deep-link to the reader for full-view scans. It's an *exact-identifier* lookup against HathiTrust's catalog records, not a fuzzy search: an `htid` is the most reliable key and ISBN works well for modern books, but an arbitrary edition's OCLC can miss even when the work is held. HathiTrust gates corpus-wide *full-text search* (it 403s automated clients and requires partner credentials), so that surface is intentionally not exposed. For full-text search *inside* a book, use `gutenberg`.

§ `gutenberg` — beyond discovery, the high-value tool is `search_inside`: legal full-text search within any public-domain book, good for **locating/verifying a quotation** (exact wording + citation offset), **detecting misquotes** (e.g. "Elementary, my dear Watson" returns zero matches in the Sherlock canon), and **term-frequency** checks (e.g. "Napoleon" × 588 in *War and Peace*). `get_excerpt` then pages through the text from any offset. Book text is fetched from the fast University of Waterloo PG mirror (gutenberg.org's own origin serves a 1 MB book in ~10 s — past the gateway wall-clock; the mirror returns *War and Peace*'s 3.4 MB in ~1 s), with gutenberg.org as fallback. Matching is case-insensitive substring (not regex/semantic), and non-English title searches need exact accents.

† `bc-workers-comp-decisions` — **live search over the two BC workers'-compensation
appeal-decision sites, neither of which has an API**: WCAT's "search past decisions"
page (with its full facet surface — keyword operators, `classification` incl.
noteworthy/precedent, application/document type, and a date range) and the WorkSafeBC
Review Division's search (2013–present). Both are parsed server-side; the tools return
each tribunal's own result summaries + a link to the official record (a WCAT decision
PDF, or the Review search) — **no full decision text is stored or redistributed**. One
site quirk is handled: WorkSafeBC uses **Post-Redirect-Get** — the search POST stores
its results under a new session cookie and 302-redirects to `/`, so the tool follows
that redirect itself and carries the antiforgery + session cookies across it (`fetch`
does not persist Set-Cookie across a redirect), otherwise the results page comes back
empty. WCAT paging/caching go through the shared throttled egress client;
`get_wcat_decision` resolves one decision by its exact number.

## Deploying one

```bash
trove mcp deploy --dir mcp/<slug>               # bundle, upload, activate
trove secret set <slug> <NAME> <value>          # for servers that declare secrets
trove mcp ls                                    # list your deployed servers
```

Servers declaring secrets (`mapbox`, `fred`, `ebay`, `x`, `jonas-premier`) return a clear "not set" /
"not declared" error until their secret is set (a secret is registered to a
server the first time you `trove secret set` it). Auth'd APIs redeem the key at
call time from the encrypted vault via `ctx.secret(...)` — it is never bundled or
logged. `ebay` uses OAuth2 client-credentials: it exchanges the App ID + Cert ID
(a **free** eBay developer account, no contract) for a 2-hour application token.

## Notes & known limits

- **`openparliament`** offers per-MP statement lookup (`mp_speeches`), not topic
  search — OpenParliament has no public JSON full-text search of Hansard.
- **Hosted servers reach only public HTTP/JSON APIs** in their manifest `egress`
  allowlist; sources that require an authenticated, logged-in session are out of
  scope for this gallery.
- **Authoring:** servers are built on the [`@ontrove/mcp`](https://www.npmjs.com/package/@ontrove/mcp)
  SDK (published to npm); `trove mcp init <name>` scaffolds a new server once the CLI is installed.
