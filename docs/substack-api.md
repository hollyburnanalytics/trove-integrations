# Substack API reference (authenticated session)

Endpoint catalog for a Substack source adapter that syncs **the signed-in
user's own subscriptions**. Substack has no endorsed API for this, so everything
below is the site's own undocumented JSON API — the same endpoints
`substack.com` and `*.substack.com` call from the browser.

**Verified live on 2026-07-26** against `substack.com`, `benn.substack.com`, and
`www.slowboring.com`. Every row is marked with how it was established:

| Mark | Meaning |
|:---:|---|
| ✅ | Called and confirmed: status code and response shape observed |
| 🔒 | Confirmed to exist and to be session-gated (returns `401 {"errors":[{"msg":"Please sign in"}]}` unauthenticated); response shape **not** observed |
| 📄 | Third-party report only (wrapper libraries / write-ups). Unverified — confirm before relying on it |

## 1. Posture before anything else

This is a reverse-engineered surface. It is unversioned, undocumented, and
Substack owes us nothing — it can change or close without notice. Two
consequences for how we build:

- **Read-only, user-scoped, entitlement-respecting.** We fetch only what the
  signed-in user can already see in their own browser. We do not use these
  endpoints to reach past a paywall (see §5.3 for the one place that's tempting).
- **This is not the endorsed path.** The endorsed path is per-publication RSS
  (`/feed`) plus Substack's own private paid feeds. Keep that as the primary
  source; treat the session API as the *discovery* layer that finds which
  publications to add. If Substack ever ships a real reader API, only §3 gets
  replaced.

The official [Substack Developer API](https://substack.com/api-tos) does **not**
cover any of this — it maps a creator's LinkedIn handle to their public profile
and nothing more. No posts, no reader data, no subscription list.

## 2. Authentication

### 2.1 The credential

A single cookie:

```
Cookie: substack.sid=<token>
```

Set on `.substack.com`, `HttpOnly`, reported lifetime ~3 months. It is a
**full-account bearer credential** — it authorizes posting, DMs, and settings
changes, not just reads. Treat it exactly like a password:

- Goes in `ctx.credentials.SUBSTACK_SID`, **never** `ctx.config` (which is
  synced to the cloud). Per `CLAUDE.md`, `config` is preferences only.
- Never log it, never include it in an error message, never put it in a document
  body or a cursor.
- Expiry is indistinguishable from revocation: on `401` throw a fatal error so
  the harness surfaces a re-auth prompt. Do not retry.

### 2.2 Obtaining it

| Route | Endpoint | Verified | Notes |
|---|---|:---:|---|
| Password login | `POST https://substack.com/api/v1/login` — `{"email","password"}` | ✅ | Empty body → `400` naming `email` + `password`, so the contract is confirmed. Sets `substack.sid` on success. Blocked for SSO/passkey accounts and by captcha. |
| Magic link | `POST https://substack.com/api/v1/email-login` — `{"email"}` | ✅ | Empty body → `400` naming `email`. Emails a one-time link; the token lands in the browser that opens it, so this is **not** headless-automatable. |
| Browser handoff | — | — | User signs in normally; harness reads the cookie from its own browser context. This is the only route that works for SSO/passkey/2FA accounts. |

**Recommendation:** do not implement `/api/v1/login`. Storing a user's Substack
password to mint session cookies is a materially worse security posture than
asking for the cookie once, and it breaks on every account with 2FA. Take the
cookie via browser handoff (`location: "client"`), or via a paste field.

### 2.3 Request headers

`substack.com` sits behind Cloudflare and does challenge on some paths — bare
requests to `/api/v1/user/{id}/subscriber-lists` returned a Cloudflare
interstitial (`403`, `Just a moment...`) in testing while sibling endpoints
returned JSON. Send browser-plausible headers:

```
Cookie:          substack.sid=<token>
Accept:          application/json
Accept-Encoding: gzip, deflate, br
User-Agent:      <a real browser UA>
```

This is the one place we knowingly depart from the repo's honest-bot-UA rule in
`lib/http.mjs`. The justification: these are a signed-in user's own requests for
their own data, and Cloudflare challenges non-browser UAs on this host. Document
it in the source header comment and keep the UA a single named constant.

## 3. Discovery — the subscription list

This is the endpoint the whole integration hinges on.

### 3.1 The one that returns everything

```
GET https://substack.com/api/v1/user/{user_id}-{slug}/public_profile/self
```

📄 **The complete subscription list in one call** — publication name, subdomain,
paid vs free tier, membership state. Reported as "the motherload" by the author
of a subscription-manager extension built on it.

Verified behaviour: the path resolves ✅ (`200` for
`/api/v1/user/5667744-benn/public_profile/self`), but **unauthenticated it is
byte-identical to the non-`/self` variant and `subscriptions` comes back empty**.
The `/self` suffix only unlocks the private subscription array when the cookie
belongs to that same user — so the *shape* below is from the wrapper library's
types, not from an observed authenticated response. Confirm against a real
cookie before building on the field names.

```jsonc
{
  "id": 5667744,
  "handle": "benn",
  "slug": "benn",
  "subscriptions": [                    // empty unless authenticated as this user
    {
      "id": 12345,
      "user_id": 5667744,
      "visibility": "public",           // "public" | "private"
      "membership_state": "subscribed", // "subscribed" | "unsubscribed" | ...
      "type": "paid",                   // null for free
      "is_founding": false,
      "email_settings": { },
      "section_podcasts_enabled": [ ],
      "publication": {                  // → name, subdomain, custom_domain, id
      }
    }
  ],
  "subscriptionsTruncated": false,      // ⚠️ check this — may need a second call
  "visibleSubscriptionsCount": 0
}
```

Field names for `subscriptions[]` come from
[`jakub-k-slys/substack-api`](https://github.com/jakub-k-slys/substack-api)
(`SubstackProfileSubscription`).

**Getting `{user_id}-{slug}`:** the path wants the composite form. The `slug` is
cosmetic in the ones tested (`/api/v1/user/benn/public_profile` also resolves
✅), but pass both. To learn the signed-in user's own id, load
`https://substack.com/` with the cookie and read `window._preloads` from the
HTML, or hit `GET /api/v1/user/settings` (✅ exists — returned `403 Not
authorized` unauthenticated, so it is session-gated).

### 3.2 The simpler-looking one

```
GET https://substack.com/api/v1/subscriptions
GET https://substack.com/api/v1/subscriptions?limit=10
```

🔒 Confirmed to exist and to be session-gated:

```
401 {"errors":[{"msg":"Please sign in","msgHTML":"Please <a native href=\"/account/login?redirect=%2Fapi%2Fv1%2Fsubscriptions\">sign in</a>."}]}
```

Response shape unobserved. It accepts `?limit=` without complaint, which hints
at pagination. Try this one **first** — it is the more obvious endpoint and, if
it returns the same data, it avoids needing the user id. Fall back to §3.1.

### 3.3 Public fallback, no cookie at all

```
GET https://substack.com/api/v1/user/{handle}/public_profile
```

✅ `200`, keyless. Returns the same envelope minus the private parts. Its
`subscriptions[]` carries only the subscriptions the user chose to make public
(`visibility: "public"`), and is capped — watch `subscriptionsTruncated` and
`visibleSubscriptionsCount`. For the account tested both were `0`/`false` with
an empty array.

Worth knowing as a zero-credential degraded mode, but it is not a substitute:
most people never make their subscription list public.

## 4. Reading — the inbox

```
GET https://substack.com/api/v1/reader/posts
GET https://substack.com/api/v1/reader/posts?limit=10
```

🔒 Session-gated (`401`, same envelope as §3.2). This is the reader inbox —
the cross-publication merged feed. Shape and pagination params unobserved.

Two nearby endpoints, for orientation:

| Endpoint | Verified | What it is |
|---|:---:|---|
| `GET /api/v1/reader/feed` | ✅ `200` keyless | The **Notes** firehose, not the inbox. Returns `{items:[{entity_key,type,context,…}]}`. Not what we want. |
| `GET /api/v1/reader/feed/profile/{user_id}` | ✅ `200` | One profile's activity. Supports `?types[]=note`, `?types[]=like`, `?types[]=restack`. Returns `{items,originalCursorTimestamp,nextCursor}`. |
| `GET /api/v1/reader/inbox` | ✅ `404` | Does not exist. |

**Cursor pagination is the house idiom.** `/reader/feed/*` paginates on an
opaque `nextCursor` with `?cursor=<urlencoded>`, `nextCursor: null` at the end.
Expect `/reader/posts` to work the same way. Note that this is an
`opaqueToken` watermark, which is **reserved, not built**, in
`docs/source-adapter-taxonomy.md` — see §7.

⚠️ A caveat on `types[]` filters, reported by the extension author: `types[]=restack`
misses Notes restacks and needs client-side filtering. Assume the filters are
approximate and verify counts.

**Recommendation:** prefer §5 (per-publication archives) over the inbox. The
archive endpoints are keyless, verified, and stably shaped; the inbox is one
undocumented call whose response we have never seen. Use the inbox only if
per-publication fan-out proves too slow.

## 5. Reading — per publication

All keyless ✅ and all on the publication's own host
(`{subdomain}.substack.com`, or the custom domain — `www.slowboring.com` works
identically).

### 5.1 Archive listing

```
GET https://{host}/api/v1/archive?sort=new&offset=0&limit=20
```

| Param | Verified behaviour |
|---|---|
| `sort` | `new` ✅ · `top` ✅ (`200`) · `community` 📄 |
| `offset` | ✅ Clean, stable paging. Walked `offset=0,20,40,60` and `offset=1000` with no repeats. |
| `limit` | ✅ **Max 50** — `51` and above return `400 {"errors":[{"param":"limit","msg":"Invalid value"}]}`. But the *response* caps lower: `limit=50` consistently returned 23 items, `limit=25`/`30` also 23, while `limit=20` reliably returned 20. **Use `limit=20`** and drive paging off `offset` for deterministic behaviour. |
| `search` | ✅ Accepts an empty string; full-text search untested |

Returns a **bare JSON array** of post summaries. Fields we need:

```jsonc
[{
  "id": 208357260,
  "publication_id": 23588,
  "title": "Brute intelligence",
  "subtitle": "…",
  "slug": "brute-intelligence",
  "post_date": "2026-07-24T17:37:09.203Z",   // ← the date watermark
  "updated_at": "2026-07-24T17:38:40.199Z",
  "audience": "everyone",                     // "everyone" | "only_paid" | "founding"
  "type": "newsletter",                       // "newsletter" | "podcast" | "thread" | "video"
  "canonical_url": "https://benn.substack.com/p/brute-intelligence",
  "truncated_body_text": "Terence Tao is a mathematician…",
  "body_html": null,                          // ← always null in the archive listing
  "podcast_url": null,
  "podcast_duration": null,
  "wordcount": 2081,
  "publishedBylines": [ ]                     // → author name(s)
}]
```

`body_html` is **always `null`** here — the listing is metadata only. One extra
call per post is required for the body (§5.2). Budget for it.

### 5.2 Single post, with body

```
GET https://{host}/api/v1/posts/{slug}        ✅ 200 — bare post object
GET https://{host}/api/v1/posts/by-id/{id}    ✅ 200 — wrapped: {"post":{…}}
```

Adds `body_html` (the full rendered body), `description`,
`truncated_body_text`, `wordcount`, `comments`, `reactions`, `audio_items`,
`podcastFields`, `cover_image`, `postTags`, `previous_post_slug` /
`next_post_slug`.

Feed `body_html` through `htmlToText()` per the repo's plain-text convention.
Podcast posts carry `podcast_url` → map to the document's `audio_url` and let
the server transcribe.

### 5.3 What the paywall actually does — read this before writing the fetch

Unauthenticated behaviour on `only_paid` posts is **inconsistent**, and that
inconsistency is a trap:

| Post | `audience` | `wordcount` | `body_html` bytes | Interpretation |
|---|---|---|---|---|
| `the-lost-joy-of-monoculture` | `everyone` | 2081 | 20266 | Full body, as expected |
| `will-ai-take-your-job-mine-everyones` | `only_paid` | 13116 | 3603 | Truncated to the free preview ✅ |
| `landlords-are-inevitable` | `only_paid` | 1831 | 12796 | **Full body returned with no cookie** |

All three had identical paywall metadata (`meter_type: "none"`,
`free_unlock_required: false`, `exempt_from_archive_paywall: false`,
`unlockedWithIP: false`, `post_preview_limit: null`), so **no field on the
response tells you whether what you got is complete.** Compare `body_html`'s
text length against `wordcount` if you need to detect truncation.

The rule for us: send the user's cookie so entitled paid content arrives
complete, and **never** treat the leaky-full-body case as a feature. Do not add
retry, host-rotation, or fallback logic whose effect is to pull paid bodies the
user hasn't paid for. If `audience !== "everyone"` and the user's subscription
is free, store the preview — same as `syncRSS()` does today for
all-rights-reserved feeds.

### 5.4 Publication metadata

| Endpoint | Verified | Returns |
|---|:---:|---|
| `GET /api/v1/publication/users/ranked?public=true` | ✅ `200` | Publication's authors: `id`, `name`, `handle`, `bio`, `photo_url`, `bestseller_tier`. Cheapest way to get a `defaultAuthor`. |
| `GET /api/v1/recommendations/from/{publication_id}` | ✅ `200` (`[]` for the pub tested) | Publications this one recommends — a discovery expansion hook. |
| `GET /api/v1/publication` | ✅ `403 Not authorized` | Requires publication-owner auth. Not for us. |
| `GET /api/v1/sections` | ✅ `404` | Does not exist at this path. |

### 5.5 Site-wide, keyless

| Endpoint | Verified | Returns |
|---|:---:|---|
| `GET https://substack.com/api/v1/categories` | ✅ `200`, ~74 KB | All categories: `id`, `name`, `slug`, `emoji`, `leaderboard_description`. |
| `GET https://substack.com/api/v1/category/public/{id}/all?page={n}` | 📄 | Publications in a category, paged. |
| `GET https://substack.com/api/v1/publication/search?query={q}&page={n}` | ✅ `200` | Returned `{"results":[]}` for `stratechery` — either the param name differs or it only matches `*.substack.com`-hosted pubs. Verify before use. |
| `GET https://substack.com/api/v1/profile/posts?profile_user_id={id}` | ✅ `200`, ~88 KB | `{posts:[…]}` — everything a user has published across publications. |

## 6. The endorsed feeds — still the primary path

Don't lose these behind the JSON API. They need no cookie and Substack
publishes them deliberately.

| Feed | Content |
|---|---|
| `https://{host}/feed` | Free posts in full; paid posts as the publisher's syndicated preview. Already used by `sources/600-technology/benn-stancil`. |
| `https://{host}/feed/private/{token}` | **Full paid content.** Substack hands this to paid subscribers on their manage-subscription page. Per-publication, per-subscriber. |

The private feed token is a bearer credential for that subscription — same
handling rules as `substack.sid` (§2.1): `ctx.credentials`, never logged.

## 7. Mapping onto this repo

### 7.1 Sync shape

```
1. Read SUBSTACK_SID from ctx.credentials        → fatal if absent
2. GET /api/v1/subscriptions                     → §3.2, fall back to §3.1
   → filter membership_state === "subscribed"
   → yields [{ host, name, tier }]
3. Per publication, oldest-first, deadline-bounded:
     GET /api/v1/archive?sort=new&offset=0&limit=20
     → stop at the first post with post_date <= cursor.value
4. Per new post:  GET /api/v1/posts/{slug}       → htmlToText(body_html)
5. cursor: { type: 'date', value: <max post_date across all pubs> }
```

### 7.2 Manifest

Within the MVP cut in `docs/source-adapter-taxonomy.md`:

```jsonc
{
  "id": "substack",
  "category": "000-general",     // a container with no fixed subject
  "kind": "scheduled-sync",
  "transport": "api",
  "watermark": "date",           // post_date. NOT opaqueToken — that's reserved
  "documentSemantics": "append",
  "location": "client",          // ← see below
  "schedule": "every 6 hours",
  "available": false,            // ← no UI to collect the cookie yet
  "config": {},                  // no secrets here
  "needs_browser": false
}
```

- **`location: "client"`** — a full-account session cookie should not sit in
  Trove's cloud. This mirrors `sources/000-general/x-bookmarks`, which is
  `client` + `available: false` for the same reason.
- **`available: false`** with the reason stated in `description`, per the
  `available` convention in `CLAUDE.md`. Flip it when the harness can collect
  the cookie.
- **`watermark: "date"`** on `post_date` keeps us inside the built set. The
  inbox's `nextCursor` would be `opaqueToken` — reserved, so don't design
  around it.

### 7.3 Required change to `lib/http.mjs`

`fetchPage()` hardcodes `HEADERS` and takes no override, so there is currently
**no way to send a `Cookie` or a custom `User-Agent`** through the repo's
guarded fetch path. `CLAUDE.md` forbids raw `fetch()` when any part of a URL is
config-derived — and publication hosts come from the subscription list, so this
qualifies.

Needed: an authenticated JSON variant that keeps the SSRF guard, timeout, and
size cap but accepts extra headers — e.g.
`fetchJson(url, { headers, maxBytes })`. Two constraints on it:

- **Only attach the cookie to Substack hosts.** Publication hosts are
  attacker-influenceable data (a custom domain in the subscription list can
  point anywhere). Gate on a `substack.com` / known-custom-domain allowlist so a
  hostile entry can't exfiltrate the session token. This is the single most
  important security detail in the whole integration.
- Redact any header named `Cookie` from thrown error messages.

### 7.4 Rate limiting

Substack publishes no limits. Observed anchors:

- `jakub-k-slys/substack-api` self-limits to **25 requests/second** by default.
- The extension author: *"Substack doesn't publish rate limits. I've added
  delays between requests and aggressive caching… heavy usage might trigger
  blocks."*
- Cloudflare challenges non-browser UAs on some `substack.com` paths (§2.3).

Repo convention (`CLAUDE.md`) is 200–500 ms between requests, which is ~2–5
req/s — an order of magnitude under the wrapper's self-limit. Keep it. With one
archive call plus one body call per new post, a user with 50 subscriptions costs
~50 + N requests per sync; a deadline bound and the `date` watermark keep that
bounded after the first run.

## 8. Open questions to settle with a real cookie

Everything marked 🔒 or 📄 above, in priority order:

1. Does `GET /api/v1/subscriptions` return the full list? (§3.2) — decides
   whether we need the user id at all.
2. `subscriptions[]` field names and whether `subscriptionsTruncated` ever goes
   true, and what the second page call is. (§3.1)
3. `GET /api/v1/reader/posts` shape and pagination params. (§4)
4. Does a paid subscriber's `/api/v1/posts/{slug}` reliably return the complete
   `body_html`, and is there a field that marks truncation? (§5.3)
5. Actual rate limit ceiling and the shape of a throttle response (`429`? a
   Cloudflare interstitial?).

## Sources

- [Substack Developer API](https://support.substack.com/hc/en-us/articles/45099095296916-Substack-Developer-API) · [API Terms of Use](https://substack.com/api-tos) — the official, unrelated API
- [`NHagar/substack_api`](https://github.com/NHagar/substack_api) — Python wrapper; public endpoint paths
- [`jakub-k-slys/substack-api`](https://github.com/jakub-k-slys/substack-api) — TypeScript wrapper; `substack.sid` auth, response types, 25 req/s self-limit
- [I built a Chrome extension to manage my 1,200+ Substack subscriptions](https://wonderingaboutai.substack.com/p/i-built-a-chrome-extension-to-manage) — `/public_profile/self`, `types[]` filters, rate-limit caution
- [No official API? No problem](https://iam.slys.dev/p/no-official-api-no-problem-how-i) — reverse-engineering method
- [Private podcast feeds](https://support.substack.com/hc/en-us/articles/4519588148244-How-do-I-listen-to-episodes-on-my-podcast-app) — `/feed/private/{token}`
