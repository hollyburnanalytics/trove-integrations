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
| `world-bank` | `search_indicators`, `get_indicator` | api.worldbank.org | — |
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
| `fred` | `search_series`, `get_observations` | api.stlouisfed.org (St. Louis Fed) | **`FRED_API_KEY`** |
| `openfda` | `search_drug_labels`, `search_recalls` | api.fda.gov | — |

### Business ops
| Toolkit | Tools | Upstream | Auth |
|---|---|---|---|
| `jonas-premier` | `list_companies`, `search_jobs`, `get_job_transactions`, `get_job_estimate`, `search_vendors`, `get_ap_invoices`, `get_ap_payments`, `get_gl_accounts`, `get_subcontracts`, `get_subcontract_change_orders` | api.jonas-premier.com (Premier Construction Software External API) | **`JONAS_USERNAME` + `JONAS_PASSWORD`** ¶|

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

※ `resend` — the fleet's first **mutating** server (`send_email` is `readOnlyHint: false`, so the host confirms before sending). It's a hosted send-email server for **automated digests/notifications to yourself** — useful where only remote/hosted MCP servers are reachable (the official Resend/Postmark MCPs are local stdio). The **recipient is fixed to the owner's `RECIPIENT_EMAIL` secret** and CC/BCC are disallowed, so the tool can only ever email that one address (it can't be steered into emailing arbitrary recipients) — a deliberate safety choice for a send-capable tool. The fixed address needs no domain setup (Resend's shared `onboarding@resend.dev` sender); to send *from* your own domain, verify it in Resend and pass `from`.

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
