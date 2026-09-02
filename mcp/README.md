# Trove toolkits

The **Toolkit** half of the repo (see [`../docs/taxonomy.md`](../docs/taxonomy.md)).
Every toolkit runs as a full MCP server on Trove's cloud; each subdirectory is
one — a `manifest.json`
(identity, egress allowlist, declared secrets) plus a `extension.ts` built on the
`@ontrove/extend/toolkit` SDK (`defineToolkit`, Zod input/output schemas, `ToolError`, the
`ctx` capability object). They run as sandboxed servers behind the single Trove
`/mcp` endpoint, with deny-by-default egress and per-tenant secret redemption via
`ctx.secret`.

> **SDK & toolchain note.** These servers are built on the `@ontrove/extend/toolkit` SDK
> (`defineToolkit`, Zod schemas, `ToolError`, the `ctx` capability object) and
> deployed with the `trove` CLI. `@ontrove/extend/toolkit` is published to npm; this repo
> pins it as a dev dependency and **typechecks every `extension.ts` against the
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
| `owid` | `search_charts`, `search_indicators`, `get_chart_data`, `get_indicator_data`, `get_chart_metadata` | ourworldindata.org + api.ourworldindata.org + search.owid.io | — ⊕|
| `canada-open-data` | `search_datasets`, `get_dataset`, `query_dataset`, `find_organizations` | open.canada.ca (CKAN — federal + provincial) | — |
| `openparliament` | `find_mp`, `mp_speeches`, `search_bills` | api.openparliament.ca (Canada Hansard) | — |
| `dnv-permits` | `search_permits`, `suggest_addresses`, `recent_permits` | app.dnv.org (District of North Vancouver) | — |
| `orgbook-bc` | `search_entities`, `get_entity`, `get_entity_history` | orgbook.gov.bc.ca (BC Corporate Registry mirror) | — ◊|
| `bc-workers-comp-decisions` | `search_wcat_decisions`, `get_wcat_decision`, `search_review_decisions` | www.wcat.bc.ca + rdpubsearch.online.worksafebc.com | — †|
| `worksafebc-cor` | `search_employers`, `get_employer_certificates`, `list_certifying_partners`, `list_certified_employers` | corcp.online.worksafebc.com (Certificate of Recognition registry) | — 🦺|
| `cra-gst-hst-registry` | `confirm_gst_hst_number` | www.businessregistration-inscriptionentreprise.gc.ca (CRA GST/HST Registry) | — 🧾|

### Geo, weather & time
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `mapbox` | `isochrone`, `geocode`, `directions` | api.mapbox.com | **`MAPBOX_TOKEN`** |
| `open-meteo` | `geocode_place`, `forecast`, `historical` (back to 1940), `air_quality` | open-meteo.com | — |
| `eccc-weather` | `find_location`, `forecast`, `observations`, `model_point`, `air_quality`, `wildfire_smoke` | api.weather.gc.ca + geo.weather.gc.ca (MSC GeoMet) | — 🍁|
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
| `toggl` | `check_auth`, `get_current_timer`, `get_time_entries`, `list_projects` | focus.toggl.com (Toggl 2.0 API) | **`TOGGL_API_KEY`** + `organization_id` setting ⏱|
| `meta-ads` | `list_ad_accounts`, `list_entities`, `get_insights`, `compare_periods` | graph.facebook.com (Meta Marketing API v26.0) | **`META_ACCESS_TOKEN`** (+ optional `META_APP_SECRET`) 📊|

### Social
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `x` | `get_user_tweets`, `get_tweet`, `get_post_replies`, `search_posts`, `count_posts`, `resolve_user`, `get_bookmarks` | api.x.com (X API v2) | **`X_BEARER_TOKEN`** (reads) · **`X_OAUTH_CLIENT_ID` + `X_OAUTH_REFRESH_TOKEN`** (+ optional `X_OAUTH_CLIENT_SECRET`) for `get_bookmarks` |

### Media
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `taddy` | `search_podcasts`, `search_episodes`, `get_podcast`, `get_episode`, `get_transcript`, `get_latest_episodes`, `get_top_charts`, `get_popular_podcasts`, `check_quota` | api.taddy.org (Taddy GraphQL Podcast API) | **`TADDY_USER_ID` + `TADDY_API_KEY`** 🎙|

### Personal / niche
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `ebay` | `search_items`, `get_item` | api.ebay.com (Browse API) | **`EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET`** |
| `shopify-catalog` | `search_products`, `lookup_products`, `get_product` | catalog.shopify.com (UCP catalog MCP) | none |
| `seats-aero` | `list_programs`, `search_awards`, `explore_availability`, `get_trips`, `live_search` | seats.aero (partner API) | **`SEATS_AERO_API_KEY`** ✈|

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
   top ten. `orderBy` is exposed and `popularity` rides along on every hit so a
   caller can judge the ranking rather than trust it. The default stays
   `search_rank` on measured evidence, not taste: across seven queries run both
   ways, `popularity` fixes exactly one ("inflation" — it lifts `CPIAUCSL` to
   #2) and materially degrades two — "unemployment rate" returns `UNRATE` then
   `CPIAUCSL`/`PAYEMS`/`ICSA`, and the exact-title CPI query displaces
   `CPIAUCNS` with the average retail price of milk and eggs. It is a good
   escape hatch for a broad one-word concept and a bad default.
4. **`count` lies under aggregation — and only when it matters.** Without
   `frequency`, the top-level `count` is the true pre-limit total. With
   `frequency` it reports the **un-aggregated** row count unless the whole
   aggregated set fit *strictly* inside `limit`: five years of daily `DGS10`
   asked for monthly answers `count: 1305` (not 60) at `limit=10`, still 1305
   at `limit=60` — the exact aggregated size — and only 60 at `limit=61`. So it
   is wrong precisely when the result is truncated, which is the one case the
   field exists for. Repeating it back would have reported "10 of 1305, 1295
   more not returned" for a 60-point series. Under aggregation it is therefore
   ignored: one extra row is requested and its presence is what says more
   exists, `availableInRange` comes back **null**, and the prose says the
   aggregated total is not reported by FRED rather than inventing one.

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

🎙 `taddy` — an **independent client for Taddy's Podcast API**, not affiliated
with or endorsed by Taddy. It is the repo's first **GraphQL** upstream, which is
why `lib/egress.ts` grew POST support (with a body-aware cache key) rather than
this server re-implementing deadlines, retry and throttling against raw
`ctx.fetch`.

**A podcast directory of 4M+ shows and 200M+ episodes**, with transcripts.
Two searches rather than one — Taddy exposes a single `search` field for shows
and episodes, but answers an episode-only filter on a series search with an
empty array instead of an error, so a merged tool would advertise arguments that
silently match nothing. Genres, countries and languages are taken as free text
("true crime", "US", "Health & Fitness › Mental Health") and resolved against
Taddy's 543 enum members, with near-matches on a miss and a refusal to guess
between two that share a name.

Three upstream behaviours drive the rest of the design.

**Quota is monthly** — 500 requests on the free tier — so `get_podcast` returns
the show *and* a page of its episodes in one request, arguments are validated
before egress, responses are cached per user in-isolate, and `check_quota`
reports the balance rather than leaving it to be inferred.

**Transcripts cost money, in two different ways.** Taddy's
`useOnDemandCreditsIfNeeded` defaults to `true`, so a missing transcript is
generated and billed at a credit apiece; `get_transcript` inverts that to opt-in
(`allow_on_demand`, default false) rather than spending silently on a tool an
agent may call across a page of results. Separately — and this is the part that
is easy to get wrong — only a transcript the *podcast* publishes is free. One
Taddy generated needs a paid plan and is metered even when it already exists,
and `taddyTranscribeStatus` reports both as `COMPLETED`, so every surface that
shows the status says which guarantee it is and is not making.

**Errors arrive as HTTP 200** with an `errors` array. Beyond mapping each
documented code to the right retryability, that shape means failures must be
kept out of the response cache — a cache that decides on status alone would pin
a "try again shortly" error for its full TTL and make the advice impossible to
act on. `lib/egress.ts` grew a `retainIf` hook for exactly this.

⊕ `owid` — an **independent client for Our World in Data's public
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

🦺 `worksafebc-cor` — **the safety-certification half of the same
counterparty check**: OrgBook says a BC firm is *registered*; this says whether
its safety program is **certified**, by whom, and until when. Keyless, over
WorkSafeBC's public Certificate of Recognition app: search employers by legal or
trade name, read one employer's certificates (certifying partner, COR type,
certificate number, expiry, and the classification units each covers), list the
eleven certifying partners, and list every employer one partner has certified.

The app has no documented API — its Kendo grids are server-paged against two
JSON endpoints, so pages come back as data rather than scraped rows. With no
reference to check against, everything below was **measured**, and five of the
findings were behaviours no amount of reading would have revealed:

1. **A search matching exactly one employer does not return a one-row grid — it
   302s to that employer's details page.** Confirmed on four separate queries
   (`al stober`, `van belle nursery`, `leddy firewood`, `teck`). An earlier
   version treated every 3xx as a failure, so the single most likely question
   this tool is asked — *is __this__ firm certified?* — came back "rejected the
   request; try again". The redirect is now resolved into the one-row answer;
   a redirect to `/Error/Index` is still a failure.
2. **Two grid columns pack two values into one field, as raw HTML.**
   `LegalName` arrives as `LEGAL</br/><i>TRADE</i>` in **131 of 739** sampled
   rows, and `CUCode` as `721028<br/>761033`. Stripping tags without splitting
   first merged a legal and a trade name into one string
   (`MAPLE RIDGE SCHOOL DISTRICT #42 SCHOOL DISTRICT 42`, with `tradeName: null`)
   and turned a two-unit employer into one unit whose code was the literal
   `721028<br/>761033`. Both were confident-looking wrong values.
3. **The five-character minimum belongs to the form, not the endpoint.** Four
   characters return real results (`bell` → 8 matches, `wood` → 45, `ltd.` →
   1781); three 302 to `/Error/Index`. Copying the form's rule made the tool
   refuse queries the service answers, so the floor is 4.
4. **An unknown certifying-partner id gets the identical 302 as a stale
   antiforgery token** — one permanent, one transient, indistinguishable from
   the response. The landing page fetched for the token also carries the partner
   list, so the id is now checked there for free; what still 302s really is
   likely transient. The two partners marked `(HISTORICAL)` are valid ids that
   list nobody, which is reported as such rather than as a bad id.
5. **`RTW` and `IDM` were invented.** An earlier COR-type map expanded them to
   English labels; neither appears in WorkSafeBC's data. Only `OHS` was
   observed, and unrecognized codes now pass through verbatim.

**Checks that came back clean** — recorded so nobody re-runs them:

- `Total` is a true total, not a page size: 214 at `take=10`, `25` and `50` alike.
- **Paging is lossless.** Identical queries return identical ids and order
  (static data), and `take=10 skip=0` + `take=10 skip=10` reproduces the
  `take=20` baseline exactly — same set, same order, no duplicates, nothing
  dropped.
- Both name filters filter: 0 violations over `LN` and `TN` result sets.
- `AccountNumber` is always the employer id zero-padded to nine digits — 739
  rows, 0 violations — which is what lets the search grid (which omits the
  field) report one anyway.
- `ExpiryDate` is `YYYY/MM/DD` in all 739 rows; the field sweep leaves nothing
  unread; `Errors` was null on every success (it is read anyway, so a populated
  one can never be reported as "no matches").
- Multi-certificate employers are real and parse correctly: City of Mission
  holds one COR from BCFSC and one from BCMSA, each with its own classification
  unit, and each unit is attributed to the certificate it sits under.

**One assumption did not survive, and the claim was rewritten rather than the
code.** `expired` was introduced on the reasoning that "a COR that lapsed in 2019
renders identically to one good until 2028". In 739 live rows **no expired
certificate appeared at all** — the earliest expiry was two days out — so the
registry evidently lists only current certificates. The flag stays as a guard
(the sample cannot see the details pages, and a certificate that lapses between
publication and reading is free to catch), but it is no longer described as the
common case.

WorkSafeBC's **clearance letter** service is deliberately *not* exposed: it
reveals a firm's clearance status only after the requester supplies a name and
mailing address, and issues an addressed letter naming them. That is a
form-filling act on someone's behalf, not a public lookup.

🧾 `cra-gst-hst-registry` — **confirm a supplier's GST/HST number** against the
CRA's public registry, for a given transaction date: the check that supports an
input tax credit on the tax that supplier charged. Keyless, no CAPTCHA, one tool.

It is a **verification, not a directory**, and every design decision follows from
that. There is no name search and no lookup by number alone; the CRA requires the
9-digit number, the business name *and* the date together, and never discloses
whose number it is. So the outcomes are not two but three, and the third is the
one that matters:

- `registered` / `notRegisteredOnDate` — the CRA's two affirmative answers. The
  negative sentence contains the affirmative one as a substring ("number **was
  not** registered on this transaction date"), so a naive substring test reports
  the opposite of the truth; the negative is matched first, with a regression
  test.
- `unconfirmed` — "Insufficient information entered", which the registry returns
  **both** for a number that was never issued **and** for a live, valid number
  whose name doesn't match. Both halves were confirmed live: `830951471` +
  `WARLINE PAINTING LTD.` registers, the same number + `Warline Painting` does
  not, and a checksum-valid but unissued number (`100000009`) returns the *same
  sentence* under two different names. Reporting that as *unregistered* would be
  a confidently wrong answer about a real registrant, so it is named as
  unconfirmed and the remedy — the exact legal name, which `orgbook-bc` supplies
  alongside the business number — travels with it.

**The name match was measured, because the advice given to callers depends on
it.** An earlier version told callers the match was "strict", implying they
needed the CRA's exact capitalization. It is not: lower case
(`warline painting ltd.`), a missing final period (`… LTD`) and padded or
collapsed whitespace all confirm. What fails is an *incomplete* name
(`WARLINE PAINTING`, `Warline`), a spelled-out suffix (`… LIMITED` for `… LTD.`),
an extra token (`… LTD. INC`) and a typo (`Pointing`). So it normalizes case,
spacing and trailing punctuation but requires the whole registered name — which
is a different instruction, and the one now given.

🍁 `eccc-weather` — **Canada's official weather, air quality and wildfire
smoke**, from Environment and Climate Change Canada's MSC GeoMet. Keyless, and
notable for its licence: the ECCC Data Servers End-use Licence grants a
"worldwide, royalty-free, perpetual, non-exclusive licence to use the
Information, **including for commercial purposes**", with redistribution allowed
on condition the source is acknowledged. Every response therefore carries the
required `Data Source: Environment and Climate Change Canada` string. That makes
it the unrestricted counterpart to `open-meteo`, whose free tier is
non-commercial only.

The pull is the **named forecast site**. ECCC publishes ~800 City Page sites, so
most towns have their own forecast point instead of an interpolated grid cell —
`find_location` resolves "West Vancouver" to `bc-99` at `-123.16, 49.33`, and a
coordinate search ranks nearby sites by great-circle distance. `forecast` then
returns three horizons from one payload: current conditions, 24 h of hourly
detail (temperature, wind, precipitation probability), and the day/night period
forecast — 12 periods, roughly six days — plus sunrise/sunset and active
warnings.

Two upstream shapes drove design decisions, both found live rather than assumed:

- **AQHI keeps superseded runs.** The forecasts collection serves several days of
  past model cycles alongside the current one, so the obvious
  `sortby=forecast_datetime` returns a *stale* run — a query for "the next few
  hours" came back with values published three days earlier. The server sorts by
  `-publication_datetime` and then keeps only the newest run, re-sorting it
  forward in time, so hours from different cycles can never interleave.
- **A calm wind is the string `"calm"`, not `0`.** Reading it as a number yields
  null, which a caller scoring "is it still outside?" cannot compare. It is
  mapped to `0` km/h explicitly. Relatedly, `condition` is sometimes absent
  entirely (the site publishes an `iconCode` with no value); the summary omits
  the clause rather than printing a placeholder.

`observations` is the only tool here that reports **measurement rather than
forecast** — the nearest SWOB surface station's latest reading. SWOB records
carry ~200 raw MSC-coded columns, so it projects a curated subset. Wind needed
the most care: stations drop individual averaging windows between observations
(a record can carry `avg_wnd_spd_10m_pst1mt` and `pst2mts` while `pst10mts` is
null), so it walks a preference list starting at the WMO-standard 10-minute mean
and **reports which window the value came from** — a 1-minute mean and a 1-hour
mean are not the same measurement, and a caller comparing them blind would be
misled.

`model_point` is the numeric counterpart to `forecast`: HRDPS surface fields at
2.5 km, hourly, roughly a 48-hour horizon. It exists mainly for **total cloud
cover**, which City Page publishes only as condition text — the earlier claim
that ECCC had no numeric cloud cover was wrong; it is `HRDPS.CONTINENTAL_NT` on
the WMS side. Wind is converted from the model's m/s to km/h so it matches the
rest of the toolkit.

Its constraint is fan-out. WMS has no bulk endpoint, so every (variable × hour)
pair is one request; the tool caps the product at 48 and rejects anything larger
up front rather than issuing it. Two failure modes are deliberately kept
distinct, because both would otherwise arrive as indistinguishable nulls:

- **Past the model horizon** — GeoMet answers an out-of-range `TIME` with an XML
  `ServiceExceptionReport` under **HTTP 200**, so parsing every body as JSON
  turns a routine horizon query into a thrown error. Non-JSON bodies are treated
  as no-data and counted in `missingHours`.
- **Rate limiting** — GeoMet returns **HTTP 429** on bursts (observed while
  building this). Those cells are detected explicitly and raise a retryable
  error naming the throttle, rather than being folded into `missingHours` where
  they would read as "past the horizon." Concurrency is held at 3 for the same
  reason.

`wildfire_smoke` is the odd one out: FireWork (RAQDPS, 10 km) is a raster model
served over WMS rather than the Features API, so a point reading comes from
`GetFeatureInfo` with a one-cell bounding box — and WMS 1.3.0 under `EPSG:4326`
orders that box **latitude-first**, the reverse of the lon-first boxes used
everywhere else here. It returns surface PM2.5 attributable to wildfire and
vegetation plumes, which is the signal that actually decides a BC summer evening.

Coverage is Canada only, and every timestamp ECCC publishes here is UTC — passed
through unchanged rather than converted, so callers localize.

**Probed against the live API** (`/test-toolkit`). Eight defects, every one a
confidently wrong answer under an HTTP 200; regression tests use verbatim
captures under `fixtures/`:

- **Pressure differed by 10× between two of its own tools.** City Page publishes
  station pressure in **kPa** (`101.5`), SWOB in **hPa** (`1011.9`). Both were
  surfaced unlabelled. The declared unit is now honoured and kPa converted, so
  `forecast` and `observations` are comparable.
- **A period precipitation probability that does not exist.** The collection's
  queryables advertise `forecastGroup.forecasts.abbreviated_forecast.pop`, but
  no live period contains `pop` in any spelling — `abbreviatedForecast` holds
  only `icon` and `textSummary`. The field was removed rather than left as a
  permanent null. The *hourly* `lop` is real (36/36 across six sites).
- **A wind chill of −2 °C at 20.7 °C.** ECCC leaves a stale `windChill` in
  `currentConditions` out of season, with `qaValue: 100`. It is now suppressed
  above freezing; a test proves it still passes through at and below 0 °C.
- **The page was reported as the answer.** `find_location` said "5 site(s)" when
  `numberMatched` was 30. It now reports "showing N of M".
- **Name search ranked by region text.** `q=` is full-text across the region, so
  "West Vancouver" returned Ucluelet, Tofino and Estevan Point — all on *West
  Vancouver Island*, 200 km away — above the actual city of Vancouver. Results
  are re-ranked by name relevance. The first attempt at this fix was inert: it
  re-ranked only the page already fetched, so a better match at position 6 could
  never surface. The candidate pool is now widened before ranking.
- **879 KB to read four fields.** Every City Page feature embeds a full
  forecast, so a coordinate lookup downloaded ~879 KB for id/name/region/geom.
  The OGC `properties` selector needs the *dotted* queryable paths (`name` is
  rejected as "unknown properties specified"; `name.en` works) — the same query
  is now ~6 KB, which is also what makes the wider ranking pool affordable.
- **The AQHI forecast began in the past.** A run also covers hours that have
  already elapsed by the time it is read — the 00Z publication still carried
  00Z–03Z at 04Z — so "the next three hours" returned three hours that had
  already happened. Elapsed hours are now dropped (falling back to the whole run
  rather than returning nothing), and the fetch window was widened, because rows
  arrive earliest-first within a run and the old limit never reached the future.

- **"Past the model horizon" asserted for a point outside it.** `model_point` at
  a London coordinate blamed the ~48 h HRDPS horizon for the *current* hour. The
  first requested hour is always inside the horizon, so all-hours-empty now
  reports an out-of-domain coordinate instead, exposed as `coverage`.

**Checks that came back clean**, recorded so they need not be re-run: `bbox`,
`location_id` and `latest` all filter correctly (0 violations); error bodies put
the message in `description` (confirmed on a 400 and two 404s); SWOB units are
consistent across 60 stations (°C, km/h, hPa, mm, %); the HRDPS m/s→km/h
conversion reconciles by arithmetic; the `limit` values never truncate (938 SWOB
stations, 844 City Page sites and 134 AQHI zones nationally, and the densest 3°
box in Canada holds 34 and 53 against limits of 200); and the maximum permitted
`model_point` fan-out — 48 reads — completes in **7.1 s** returning 1.6 KB, well
inside the gateway wall clock and without tripping the 429.

**Still true after probing:** ECCC publishes no visibility anywhere. SWOB's 75
observed fields carry none, no HRDPS layer title matches it (the one "visible"
hit is top-of-atmosphere solar flux), and City Page exposes it only as prose in
a period summary. That gap is measured, not assumed.

Two transport claims were asserted before they were tested, and one was wrong.
Dropping the session cookie does **not** re-render the empty form as originally
commented — it serves a bilingual *"Invalid Form Submission — for your
protection, the form submission was ignored"* page with no Screen ID and no
verdict. It is correctly treated as retryable, and the cookie is now required up
front rather than treated as optional. The Struts token *is* single-use as
claimed: replaying one redirects to `srvmsgNvldTkn.jsp`. The result screen also
echoes the submitted number back, and that echo is now compared against what was
sent, so a crossed session cannot deliver an answer about a different business.

**Checks that came back clean**: the transaction date must be exactly
`yyyy-mm-dd` (`2026/07/01`, `01-07-2026` and `2026-7-1` are all rejected by the
CRA, which the Zod pattern already matched); validation short-circuits to one
message at a time rather than aggregating; and the service advertises **no**
rate-limit or quota headers, so there is nothing to surface as a budget.

Input rejections (a bad check digit, a future transaction date) come back in the
CRA's own words rather than a generic failure. Terms of use: the CRA asks that
the registry be used only to validate a business's GST/HST number and prohibits
commercial reproduction of results, stating it "is not intended to be a search
engine" — this server matches that shape on purpose: one number per call,
nothing stored, no bulk tool.

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

⏱ `toggl` — **read-only view of the caller's own Toggl 2.0 account**, built
for the questions people actually ask it: *what did I work on this week, how
much of it was billable to whom, and what am I tracking right now.* Entries
come back resolved to **project, client, task and tag names** — not the bare
ids the API returns — plus a per-client duration roll-up; `period` accepts
`today`/`yesterday`/`week`/`lastWeek`/`month`/`lastMonth` alongside explicit
dates, and `list_projects` turns a name into the id the entry filter takes.

This is the **Toggl 2.0** API (`focus.toggl.com/api`, the "Toggl Focus API" in
its own OpenAPI document), not Toggl Track's v9 — a different product on a
different host with a different credential and a different budget, and the
three differences shape everything below.

**The credential is a bearer API key, and it expires.** Toggl 2.0 keys
(`toggl_sk_…`) are generated once in the profile settings, shown once, one
active key per user, and expire on the date chosen at generation — so a 401 is
as likely an expired key as a wrong one, and the error says so. Track's Basic
`token:api_token` scheme does not exist here; a Track token stored as
`TOGGL_API_KEY` is rejected with `invalid_session`.

**The budget is an hourly quota, and it answers 402.** Free plans get **30
requests an hour** per user per organization, Starter 240, Premium 600, shared
with every integration using the key — and Toggl signals exhaustion with HTTP
**402**, on the reasoning that it is the plan's allocation that ran out. Every
response carries `X-Toggl-Quota-Remaining` / `-Resets-In`, so the toolkit reads
the budget off each call (structured `quota`, plus a prose warning below five
left) rather than discovering it by hitting it, and maps 402 to a *retryable*
error naming when the window resets. Thirty an hour also decides the shape of
the tools: **each costs one request.** The entry list comes from
`/time-entries/stream`, which returns the whole window as one array with
`project` (and its `client`), `task` and the effective `tags` embedded, so
there is no paging to get wrong and no lookup afterwards. Two flags there are
load-bearing: `include_taskless=true` (entries logged without a task — every
Track-migrated entry, and anything typed straight into the timer — are dropped
without it) and `archived=false`.

**Every resource is addressed by organization *and* workspace, and an API key
can list neither.** `/workspaces/{id}/context`, which returns the organization
for a workspace, is documented as session-only ("API-key callers are
rejected"), and organization membership lives on `accounts.toggl.com`, a host
the key does not reach. Both ids are in the web app's address bar —
`focus.toggl.com/<organization id>/workspaces/<workspace id>/…` — so
`organization_id` is a **toolkit setting** (the tools refuse to call out
without it, naming where to look), and `workspace_id` defaults to the one the
account has open (`current_workspace_id` on `/users/me/settings`, the one
API-key call Toggl's own authentication page demonstrates). A toolkit with both
set spends nothing on scope. The old `list_workspaces` tool went with Track:
there is no endpoint left to implement it on.

Two smaller points. **Named periods are timezone-aware**, as before, but the
Toggl 2.0 filters are *timestamps* rather than dates, so the toolkit sends the
zone's own midnights (`zonedMidnight`, DST-safe) — a bare date would start a
Vancouver "today" seven hours early. And **a running entry has no `duration`**
(the offline-sync notes say an entry "cannot be made running again by clearing
it"), so `running` is read from its absence; the elapsed time is computed for
display and the entry is listed but never counted. Breaks (`type: "break"`) are
left out unless `include_breaks` is set.

Everything above is built from the OpenAPI document and the published
reference; none of it has yet been checked against a live key. The hypotheses
most worth probing first, in the order they would bite: whether
`/time-entries/stream` returns one JSON array or NDJSON (both are parsed),
whether the workspace list is scoped to the caller or to everyone the caller
may see (`user_id` filters either way), and whether `date_to` is exclusive.

✈ `seats-aero` — **airline award availability across 26 mileage programs**, over
the Seats.aero partner API. Four tools cover the upstream — the cached search by
airport and date range (`search_awards`), the per-program Explore browse by
continent (`explore_availability`), the flights behind one availability
(`get_trips`), and `live_search` — plus a fifth, `list_programs`, that answers
from a local table. The key is the user's own: Seats.aero grants partner API
access to **Pro subscribers**, who generate a key on the API tab of their
settings page, for **non-commercial use** unless Seats.aero has agreed otherwise
in writing.

**Everything below was verified against a live Pro key**, and that mattered: the
published reference documents roughly a third of the fields these endpoints
actually send, and two of its omissions are the difference between a right and a
wrong answer. The availability and trip test fixtures are verbatim captures of
real responses rather than hand-written shapes.

**`live_search` needs a commercial agreement and a Pro key cannot use it.** The
reference presents it as part of the partner API and never says otherwise; live,
it answers `401 {"error":"Your API key is not enabled for the live search API.
Live search requires a commercial agreement with seats.aero."}`. Two consequences
are built in: the tool's description says so up front, and a 401 whose body
mentions live search is mapped to an entitlement message rather than the generic
"check your API key" — which would have sent a Pro user to replace a key that
works perfectly on every other tool.

**The cheapest price and the non-stop price are different numbers.** This is the
single most dangerous thing in the API. Each cabin carries `JMileageCost` (the
cheapest itinerary of *any* routing) **and** `JDirectMileageCost` (the cheapest
non-stop), and the reference documents only the first, alongside a `JDirect`
boolean that invites pairing the two. United SFO→LHR on 2026-09-01 is **40,000
miles in economy via Denver and 65,400 non-stop** — so the obvious reading
reports a connecting price as the price of a non-stop, understating a non-stop
award by 63%. The two shapes are decoded as separate offers, and every price
states its routing outright.

**`include_filtered` unlocks fields the reference never defines.** Alongside
every cabin field is a `…Raw` twin carrying the same figure *before* Seats.aero's
dynamic-pricing filter — `WMileageCost: "0"` with `WMileageCostRaw: 135900`. A
cabin can be entirely invisible in the documented fields while a real, very
expensive dynamically-priced award sits in the raw ones, so reading only the
documented half made the flag look like a no-op. Those land in a `dynamic` block,
spelled out in the prose **only when the filtered view has nothing for that
cabin** — the case where silence would read as "no space in this class". (The raw
fields ride along on every row, not only with `include_filtered`; that flag
controls which *rows* come back, not which fields they carry.)

Three more undocumented surfaces are now read rather than dropped: **per-cabin
taxes** on the summary (`JTotalTaxes` + `TaxesCurrency`), which otherwise cost a
whole extra `get_trips` call per result on a 1,000-a-day budget; **co-brand card
rates** (`OptionalPricing`/`OptionalPrices` — a United cardholder pays 36,000
where the standard award is 40,000); and the trip-level `Connections`, full
`Aircraft` names, `FareClasses` and `TotalSegmentDistance`.

**Four documented conventions are corrected rather than relayed**, because taking
any at face value yields a confident wrong answer rather than an error:

1. **`DepartsAt`/`ArrivesAt` end in `Z` but are airport-*local* times.** Live:
   UA2199/UA938 leaves SFO at 14:05 and reaches LHR at 11:55 the next day —
   21h50m of wall clock read as UTC, against a reported `TotalDuration` of 830
   minutes (13h50m), which reconciles only as local clocks. Times render local
   and labelled; no `Z` survives into the output.
2. **`*MileageCost` is a string, and `"0"` means "not priced", not "free".**
3. **`*RemainingSeats: 0` on a bookable cabin means "not reported".** Eight
   programs are documented as never publishing seat counts and three as never
   publishing taxes, so the program table names the gap instead of printing
   `0 seats` or `$0.00`. That table is treated as *softening an explanation*,
   never as overriding data — Qantas is listed as publishing no seat counts and
   returned four, which the output reports as four.
4. **`count` is the page size, not a total.** `take=10` answers `count: 10` with
   `hasMore: true` on both paged endpoints, so it can never say how much matched.
   It is reported under its own name; summaries are built from `returned` +
   `hasMore`, and a truncated page says which `skip`/`cursor` to resume from —
   plus the API's own `moreURL`, another undocumented field.

Trip segments carry an explicit `Order` and array position is not documented to
match it, so legs are **sorted before** the first one's origin and the last one's
destination become the trip's endpoints; live-search segments have no `Order` at
all, so their arrival order stands (the sort is stable). One availability really
can return **59 trips**, so `get_trips` sorts cheapest-first, spells out 25, and
says how many it held back — all of them stay in the structured result.

Requests that would come back as an empty HTTP 200 are refused before a call is
spent: an **unknown mileage-program slug** (named, with near-miss suggestions), a
**cabin no requested program supports**, and a **reversed date range**. A window
more than a day in the past is flagged rather than answered with a bare zero —
with a full day of slack rather than a time zone, because a departure date is
local to the origin airport and there is no single "today" to compare against.

Responses are parsed against **lenient Zod schemas** via `ctx.fetchJson`, as
`openlibrary`/`usgs-quakes`/`holidays` do — every field `nullish` or defaulted,
numbers accepted as either JSON numbers or strings (mileage costs really do
arrive as strings on availabilities and numbers on trips, sometimes in the same
record). One drifted field degrades that field instead of failing a page of good
results, and the availability schema keeps unknown keys so a new prefixed field
survives parsing. The `cursor` is documented as opaque — "currently a Unix
timestamp" — so it is echoed verbatim and both the input and the output accept a
number *or* a string, rather than pinning a type the reference declines to
promise.

**The quota is readable, so it is read.** Every response — success or refusal —
carries `x-ratelimit-limit`/`-remaining`/`-reset`, which the reference never
mentions. That number is in every structured result, the prose warns once the
remaining count drops under 50, and a 429 says *when* the budget returns
("resets in 5h 57m") instead of inviting a retry that cannot succeed. It is the
one thing worth reaching past `ctx.fetchJson` for: the quota lives only in the
headers, and on a key allowing 1,000 calls a day *shared across every app using
it*, budgeting beats discovering the ceiling by hitting it.

Three more things live testing settled, each of which had produced a wrong
behaviour built on the documentation:

- **`take`'s documented bounds are not enforced.** The reference says ">= 10 and
  <= 1000"; `take=3` returns three records and `take=1001` returns 1001, both
  HTTP 200. The floor was being reproduced as a Zod `.min(10)`, so the tool was
  *refusing requests the API serves*. It now accepts 1–1000, with the ceiling
  described as this toolkit's response-size guard rather than as the API's rule.
- **`minify_trips` is not a light trim.** It keeps nine fields — ids, cabin,
  carriers, miles, taxes, seats, stops, duration — and drops everything else,
  including the per-leg `AvailabilitySegments`, `Source` and `TaxesCurrency`.
  The last two are what make the rest intelligible, and both sit on the parent
  availability, so embedded trips now inherit them; without that a minified trip
  decodes to "unknown program" with an unlabelled sum of money. Its description
  says what it costs, so it is chosen for pricing sweeps rather than itineraries.
- **Airport codes are not case-sensitive** — `origin_airport=sfo` returns the
  same results as `SFO`. The code had claimed otherwise to justify upper-casing;
  the normalisation stays (it keeps the echoed route consistent) but the
  justification was corrected rather than left as a plausible-sounding falsehood.

**Almost nothing is an error.** A city name in place of an airport code, an
unknown mileage program, an unknown region, a route to itself, a reversed date
range and a wholly past window are all `{"data":[]}` with an HTTP 200 — only a
malformed date and an unknown cabin actually 400. Each is named client-side
before a call is spent, including the newest: an airport listed as both origin
and destination.

A systematic sweep settled the field question rather than leaving it to
inspection — the union of every key across a 1.7 MB multi-program response was
diffed against the parse schemas, and the only two the toolkit does not read are
a trip's `CreatedAt`/`UpdatedAt` (an availability's `UpdatedAt`, the one that
says how stale a price is, *is* surfaced).

**`skip` does not enumerate the result set, so the tools stop recommending it.**
This is the most consequential measurement here, because the obvious advice —
"call again with the next `skip`" — silently loses data. With the result set
proven static (the same query returns the same twenty ids in the same order,
cursor or no cursor), paging that query as 10 + 10 **recovered 10 of the 20**,
repeated 3, and returned 7 the single call never contained. Carrying the cursor
exactly as the reference instructs changed nothing, and `order_by=lowest_mileage`
was worse: **1 of 20**. The behaviour fits a sort applied to the *fetched window*
rather than to the whole match set, which makes `skip` an offset into an ordering
that does not exist. The footer therefore leads with **raise `take` and re-run**
— the same single API call, bounded only by response size — and names paging as
lossy in both directions rather than repeating the reference's duplicates-only
warning. `skip`/`cursor` remain available, described honestly.

**The reference table is wrong about eight of the twenty-six programs, so it
no longer refuses anything.** Sampling 300 live records per program: five listed
as publishing no seat counts do publish them (emirates, qantas, qatar, turkish,
singapore — leaving only azul and frontier genuinely silent), two listed as
publishing taxes never did (eurobonus, ethiopian), and **Lufthansa sells a
premium-economy cabin the table omits**. That last one mattered: an earlier
version *threw* when no requested program listed the requested cabin, so
`sources:[lufthansa] cabins:[premium]` was refused outright — a search that
returns real availability, blocked by a stale transcription. Cabin coverage is
now a note, never a refusal, and two rules keep the table safe regardless of
further drift: observed data always wins over the flag, and the flag may only
soften the explanation of a *missing* value.

**`take` is clamped when trips are embedded, because the ceiling is a timeout.**
Measured: `take=1000` alone is 2.1 MB in 1.6 s, but the same page with
`include_trips` is **11.5 MB in 8.4 s** — at or past the hosted gateway's wall
clock before this server has parsed a byte. Nothing had stopped that
combination. `include_trips` now caps the page at 200 (500 with `minify_trips`,
which halves the payload), clamped with a note rather than refused, since the
request is legitimate and the limit is ours.

**`include_filtered` matters far more on `get_trips` than on a search.** One
availability returns 59 trips without it and **178 with** — and the extra 119
hold the only premium-cabin itineraries it has, every one dearer than every
economy award. That broke the prose summary: ranked purely cheapest-first, all
25 spelled-out slots went to economy and the flag appeared to do nothing. The
summariser now guarantees **the cheapest line in each cabin** before filling the
rest by price, so a newly revealed cabin costs at most three slots to surface.

The four request filters were each verified against 200 live records rather than
assumed: `only_direct_flights`, `cabins`, `carriers` and the documented
interaction between the first two (`only_direct_flights` "respects the cabin
parameter") all filtered exactly, zero violations. The transport's hand-rolled
guards — unreachable host, a 200 carrying HTML, a 200 of the wrong shape — are
asserted rather than claimed, since replacing `ctx.fetchJson` made them this
toolkit's responsibility.

Two smaller checks came back clean, and are recorded so nobody re-runs them: the
**six documented regions are all of them** (2,000 records across two global
programs produced no seventh), and `origin_region`/`destination_region` filter
exactly (200/200 matched `Europe → Asia`, zero violations). The **cursor has been
an integer in every observation**; the input and output still accept a string
because the reference calls it opaque, not because one was seen. A program asked
for a region or cabin it does not serve answers with an empty 200 — the cabin
case is refused client-side from the program table, and an empty result now names
the filters that silently produce one instead of just saying "no matches".

📊 `meta-ads` — **ad performance out of the official Meta Marketing API**
(Facebook + Instagram), pinned to Graph `v26.0`. Four tools: `list_ad_accounts`
(also the "does my token work" check), `list_entities` (campaigns/ad sets/ads
with status, objective, budget and schedule), `get_insights` (the workhorse) and
`compare_periods` (two windows, joined and ranked by what moved). Auth is one
long-lived `META_ACCESS_TOKEN` with the **`ads_read`** permission — a user or
system-user token — attached as a Bearer header rather than an `access_token`
query parameter, so it never lands in a URL that gets logged or cached;
`META_APP_SECRET` is optional and needed only by apps that switched on "Require
app secret", where it becomes the `appsecret_proof` every call must carry.

Four properties of this API shaped the design, and each is a way to be
**confidently wrong** rather than to fail:

- **Absence is not zero.** Insights rows exist only for entities that DELIVERED
  in the window, so a paused campaign is missing rather than reported at zero.
  An empty answer therefore means "nothing ran", not "nothing exists" — every
  empty result says so in prose, and `list_entities` is the tool that can see
  what insights cannot.
- **Every number arrives as a string, and money carries no currency.** `spend`
  is `"1204.55"`; a daily budget is `"5000"` in the account currency's *minimum
  unit*. Metrics are coerced, budgets converted (with the raw minor units kept
  alongside, and the six whole-unit currencies — JPY, KRW, VND, CLP, ISK, TWD —
  handled rather than divided by 100), and the currency CODE printed next to
  every amount: a Canadian advertiser reading a bare `$` is wrong by a third.
- **The page is not the result set.** Graph pages everything, and its
  `cursors.after` is present on the last page too — so `paging.next` is the only
  honest "there is more" signal. It drives an explicit `TRUNCATED:` line, and
  `include_totals` asks Meta for spend across ALL matching rows so a truncated
  answer can say what share of the account it holds. `sort` is a documented
  parameter but nothing in the response says whether it was applied, so the
  returned order is CHECKED rather than trusted; when it does not match the
  request the page is sorted here and the caller is told the ordering covers the
  page only.
- **Rates cannot be averaged.** Totals recompute CTR/CPC/CPM from summed
  spend/clicks/impressions — the mean of per-row CTR weights a 12-impression
  campaign like a 12-million one — and `reach` is deliberately never totalled,
  because it counts de-duplicated people and summing it double-counts everyone
  reached twice.

Two more decisions are worth naming. **Attribution defaults to the ad set's own
setting** (`use_unified_attribution_setting`), because the first question anyone
asks of a number is why it disagrees with Ads Manager; passing explicit
`attribution_windows` overrides it and says so in the result. And **errors are
sorted by remedy**: Graph answers an expired token, a missing Business Manager
role, a rate limit, a too-large query and a mistyped field all with HTTP 400 and
a code, so `errors.ts` maps those codes back to four different instructions
instead of sending everyone to check their credentials. Rate-limit consumption
is reported too — Meta puts it only in the `x-fb-ads-insights-throttle` and
`x-business-use-case-usage` headers, so the toolkit taps `ctx.fetch` to read
them and warns at 75% rather than at the call that fails.

**Audited against Meta's own generated SDK, not against memory.** The Marketing
API publishes no OpenAPI document, but `facebook-python-business-sdk` is
generated from the same internal schema and pinned to a Graph version — so every
field, breakdown, date preset, attribution window and delivery status it accepts
is a string literal in those classes. `bun run audit:meta`
(`scripts/audit-meta-fields.mjs`) diffs what this toolkit declares against what
the SDK says exists and fails on anything that is not there. That closes the
toolkit's one un-typecheckable gap: a field name is just a string in a query
parameter, `tsc` is happy with `spendz`, every test passes because the fixtures
are ours, and the mistake surfaces only as an error 100 that fails the WHOLE
request. Against SDK v26.0 all 14 declared sets are clean — 47 insights fields
at ad level, 20 date presets, 11 breakdowns, 12 effective statuses, and the
campaign/ad set/ad/account field lists. The same audit confirmed the parameter
surface (`summary` is `list<string>`, `filtering` is `list<Object>`,
`time_range` is a `map`, `sort` is `list<string>`) and that `effective_status`
is accepted on the parent edges this toolkit uses.

The audit's second use is reading the SDK's `_field_types`, which is where a
review of this work found the sharpest bug: Meta types **costs and averages as
the same `list<AdsActionStats>` shape as counts**. `cost_per_conversion` and
`video_avg_time_watched_actions` are wire-identical to
`video_p25_watched_actions`, so the obvious mapping totals them — and the sum of
a cost per purchase and a cost per lead is the cost of nothing. Counts are now
totalled; costs, averages, ratios and rates become a per-type map (`rates`, or a
named one like `costPerConversion`), with the scalar kept only where a single
type makes it real. The same rule stops two ROAS ratios being added into a
return nobody earned. A second pass found the same defect one field further out —
`outbound_clicks_ctr`, in the DEFAULT metric set, is a list of per-action-type
percentages — so the rule was inverted: only an explicit allowlist of count
fields is summed, everything else (including anything a caller adds through
`extra_fields`) becomes a map, and `audit:meta` fails if a name on that
allowlist stops being list-typed upstream. Its `--verbose` output prints every
list-typed field the toolkit requests and how it combines it.

The other findings across the two reviews: `effective_status` is a **different
enum per level** (6 values for a campaign, 7 for an ad set, 12 for an ad —
review statuses are ad-only), so it is validated per level and audited per level
rather than as a union; campaign/ad set/ad ids have to be numeric before they
are interpolated into a URL path, since `/{id}/insights` with a non-id would
point an authenticated call somewhere the caller never named; an entity id is
not scoped to the account resolved for it, so both `get_insights` and
`list_entities` now report the account the DATA came from and price budgets in
its currency; a query narrowed to one entity no longer demands an ad account it
would never use; and a `previous_year` baseline clamps 29 February instead of
rolling it into March.

**Terms posture — read this before listing it anywhere.** Meta's terms constrain
who may call this API and on whose behalf, and they bind the owner of the *Meta
app* the token belongs to. This toolkit deliberately has **no Trove-operated
Meta app and no OAuth flow**: each user brings a `META_ACCESS_TOKEN` minted from
their **own** app or Business Manager system user, against ad accounts they
already hold a role on. That is Meta's supported "own use" path, and it keeps
App Review, Advanced Access to `ads_read`, and Business Verification as
obligations of the account owner rather than of Trove
([Marketing API authorization](https://developers.facebook.com/docs/marketing-api/overview/authorization)).
The practical cost is the default **Limited/Development access tier**, which
Meta describes as heavily rate-limited per ad account — which is why the
rate-limit telemetry above exists.

Two things follow, and neither is optional:

- **Trove is the user's service provider for this data, and has to act like
  one.** Meta's [Platform Terms](https://developers.facebook.com/terms/) tell a
  developer to "protect and not transfer, share, or solicit" access tokens
  except to service providers operating their app. A user pasting their token
  into Trove is doing exactly that, which puts Trove inside the service-provider
  carve-out and inherits its duties: process the data only for that user's
  purposes, delete Platform Data when it is no longer needed or when the user
  asks, and never sell or license it. The in-isolate response cache (5-minute
  TTL, per-caller salted) and the vault-held token are the technical side of
  that; the written commitment is a product/legal artefact, not a code one.
- **The moment Trove operates a single Meta app that users OAuth into, the
  posture changes completely.** That is the "Tech Provider" model, and it
  requires Advanced Access to `ads_read` via App Review, Business Verification,
  and a Data Protection Assessment — plus, per the current docs, a usage record
  (500+ Marketing API calls in 15 days, <15% error rate) before the access tier
  can be raised. Do not ship that variant on the strength of this one.

**Naming.** Meta's
[logo and trademark rules for apps](https://developers.facebook.com/docs/app-review/resources/logos/)
forbid a third-party product name that includes their marks or combines them
with generic terms; accurately stating that a product *integrates with* the
platform is permitted. The directory id `meta-ads` is an interoperability
identifier in the sense NOTICE.md describes, the same as `ebay` or `x`; the
user-facing name and description avoid presenting a Meta brand as the product,
and state plainly that this is an independent client, not affiliated with or
endorsed by Meta.

**None of the above is legal advice, and it is not a clearance.** It is a
reading of the published terms as of the date of this commit, recorded so the
open questions are visible. A public marketplace listing should have counsel
look at the service-provider commitment and the naming before it goes live.

Three capabilities are deliberately **not** exposed, and the audit is what makes
that a decision rather than an oversight. `action_breakdowns` re-shapes `actions`
from a list into a matrix (one entry per action type × slice) that a flat
`{action_type: count}` map cannot represent. `results`/`cost_per_result` — what
Ads Manager's own "Results" column shows — use an `indicator` + nested `values`
shape rather than `{action_type, value}`, so they would parse to nothing. And
`time_ranges` would let `compare_periods` fetch both windows in ONE call; it
stays two calls so that each window gets its own top-N page, rather than one
page split unpredictably across both.

**Still not exercised against a live ad account.** Names and parameter types are
now verified; behaviour is not. The places to check first with a real token:
whether `sort` is honoured at each level (the toolkit already checks the
returned order rather than trusting it), whether `summary` is accepted alongside
every field set, and whether `filtering` on `campaign.id`/`adset.id`/`ad.id`
narrows as expected — the single-id case now avoids that question entirely by
reading from the entity's own insights edge.

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
trove toolkit deploy --dir mcp/<slug>               # bundle, upload, activate
trove secret set <slug> <NAME> <value>          # for servers that declare secrets
trove toolkit ls                                    # list your deployed servers
```

Servers declaring secrets (`mapbox`, `fred`, `ebay`, `x`, `jonas-premier`, `seats-aero`, `meta-ads`) return a clear "not set" /
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
- **Authoring:** servers are built on the [`@ontrove/extend/toolkit`](https://www.npmjs.com/package/@ontrove/extend/toolkit)
  SDK (published to npm); `trove toolkit init <name>` scaffolds a new server once the CLI is installed.
