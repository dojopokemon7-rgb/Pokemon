# Scrydex Audit Report (Checkpoint A) — REVISED

> **Spec:** `scrydex-migration` · **Task 1.3 (revised x3)** · **Reqs 1.3, 1.4, 1.5, 1.6**
> **Status: READ-ONLY DOC-RECONCILED REVISION.** No live API probe, no bulk refresh,
> no paid credits were used to produce THIS REVISION. Findings below are reconciled
> against Scrydex's current official documentation and Terms of Service.
>
> **Scope of changes — read carefully (do not mislabel the worktree):**
> - *This revision* changed exactly one file: this report (`docs/SCRYDEX_AUDIT.md`).
>   No service, script, test, or spec file was touched by this revision.
> - *The overall worktree is NOT docs-only.* It already contains code and spec changes
>   from earlier Checkpoint-A work: a MODIFIED service (`src/lib/services/scrydex.service.ts`),
>   a NEW script (`scripts/audit-scrydex.ts`), a NEW test (`tests/unit/audit-scrydex.test.ts`),
>   and NEW spec files under `.kiro/specs/`. Any "docs-only" statement applies to this
>   revision's diff alone, never to the worktree as a whole.

## Verification legend

Every material claim carries one of these tags so documented facts are never confused
with assumptions or things that still need an account-specific or live check:

- **DOC-VERIFIED** — read directly from an official Scrydex page during this revision
  (links in the Sources section). Highest confidence.
- **DOC-STATED** — stated in the task's doc-reconciliation brief and consistent with the
  Scrydex docs, but the specific doc page was not retrievable during this revision
  (Scrydex renders several doc pages client-side; they 404 to a plain fetch). Confirm by
  opening the linked page in a browser. Medium confidence — treat as documentation, not
  as a live measurement.
- **CORROBORATED** — supported by an independent secondary source (cited), not Scrydex's
  own page. Supporting only.
- **ACCOUNT-SPECIFIC** — a documented figure whose real value for *our* plan/account can
  only be confirmed against the dashboard or a live call. Not a live measurement here.
- **PENDING LIVE RUN** — genuinely unknowable without an owner-approved live request;
  listed in the "Remaining live checks" section with purpose and max credit cost.

---

## Transport & auth (applies to every area)

| Property | Value | Status |
|---|---|---|
| Base URL | `https://api.scrydex.com` | DOC-VERIFIED |
| Per-game path slug | Pokémon `.../pokemon/v1/...` | DOC-VERIFIED (price_history + listings examples use it) |
| One Piece routes | `.../onepiece/v1/...` are **publicly documented**; account-level data access/coverage may still need confirmation | DOC-STATED (routes documented; our account's coverage unconfirmed) |
| Auth headers (both required) | `X-Api-Key: <SCRYDEX_API_KEY>` **and** `X-Team-ID: <SCRYDEX_TEAM_ID>` | DOC-VERIFIED (both shown in official curl examples; missing team id -> 401) |
| Card identifier in path | the **Scrydex card ID returned by the Scrydex card response** (official examples `xy1-1`, `zsv10pt5-105`, `me55c-4`). Mapping to Dojo `externalId`/`scrydexId` is **unverified** — see the "ID mapping" note. | ID MAPPING UNVERIFIED |
| Price currencies | USD and JPY documented; EUR "still being developed" | DOC-STATED (see Area 1 / FX implications) |
| Rate limits | no fixed daily limit asserted; Scrydex may impose quotas, concurrency and rate limits at any time; "excessive/atypical usage" may be throttled or suspended | DOC-VERIFIED (Terms section 7, "Fair AI Usage") |

---

## Credit model (reworked — Reqs 1.3, 5 of the revision brief)

Documented per-request credit costs. These are **documented list costs**, separated from
account-specific confirmation and from any assumption about failed requests.

| Operation | Documented cost | Status |
|---|---|---|
| Standard API request (search, single card, listings, population) | **1 credit** | DOC-VERIFIED (Vision page states "standard metadata typically 1 credit") |
| Price history request (`/price_history`) | **3 credits** | DOC-STATED; CORROBORATED (no direct per-endpoint credit page retrieved) |
| Vision identify (`/vision/v1/cards/identify`) | **5 credits** | DOC-VERIFIED (Vision page) |
| Monthly allotment (plan-dependent) | fixed per plan; monitor via `/account/v1/usage` | ACCOUNT-SPECIFIC — confirm our plan on the dashboard |

- **CORROBORATION** for the 1 / 3 / 5 split: an independent third-party migration note
  describes Scrydex as metering "1 credit per general request, 3 per price history, 5 per
  Vision call" against a fixed monthly allotment
  ([mgz-pkmn issue #368](https://github.com/mgzwarrior/mgz-pkmn/issues/368)). This is a
  secondary source, not Scrydex's own page — treated as supporting evidence only.
- **Failed-request cost is NOT assumed free.** The earlier revision of this report claimed
  GET existence probes cost ~0; that claim is withdrawn. Scrydex's Terms do not state that
  unsuccessful requests are uncharged, and the billing behavior for 4xx/5xx responses is
  **ACCOUNT-SPECIFIC / PENDING LIVE RUN**. Budget as if every dispatched request may be
  billed until confirmed on the dashboard.
- **AI features cost more and are explicitly variable.** Terms section 6 states image
  recognition "may consume credits at significantly higher rates than standard API
  requests," consistent with the documented 5-credit Vision cost.
- **Credit usage updates on a 20–30 minute delay (DOC-VERIFIED, Rate Limits page).** Usage
  (via the `/account/v1/usage` endpoint: `total_credits`, `remaining_credits`, `used_credits`,
  `overage_credit_rate`) refreshes only every ~20–30 minutes, so an **immediate before/after
  read CANNOT reliably measure the cost of a single request** — the earlier plan to diff the
  balance right before and after each probe is withdrawn. Measure instead with DELAYED
  readings (wait past the refresh window, or compare day-over-day) or ask the provider to
  confirm per-op cost. The Remaining-live-checks table reflects this. (Note: `/account/v1/usage`
  is itself a standard request and consumes 1 credit.)

### Limits — three DISTINCT things (do not conflate)

| Limit | Value | Status | Nature |
|---|---|---|---|
| Documented request rate | **100 requests / second** (429 on exceed, all plans) | DOC-VERIFIED (Rate Limits page) | hard documented API ceiling, independent of plan |
| Account quota / monthly allotment | plan-dependent; monitor via `/account/v1/usage` | ACCOUNT-SPECIFIC | billing/credit budget, confirmed on dashboard |
| Cloudflare bot-mitigation | rapid automated repeats can HANG (not error) | OBSERVED | edge protection seen in prior probing, not a documented numeric limit |

These are separate: the 100 req/s figure is a documented throughput ceiling; the account
quota is how many credits we may spend; the Cloudflare behavior is an observed edge effect
that made the earlier audit space calls 3–5s apart. Budget and backoff logic must respect
all three independently.

---

## Area 1 — Catalog, current price & PRICE HISTORY (Scrydex_Service)

### 1a. Catalog + current price

| Field | Value |
|---|---|
| **Search (GET)** | `GET /pokemon/v1/cards?q=name:<term>&pageSize=<n>&include=prices` -> `{ data: Card[], page, page_size, count, total_count }`. `include=prices` REQUIRED or `prices[]` absent. DOC-VERIFIED pattern; search-query colon syntax from contracts file. |
| **Single card (GET)** | `GET /pokemon/v1/cards/{id}?include=prices` -> `{ data: Card }`. Path `{id}` = the Scrydex card ID returned by the Scrydex card response; mapping to Dojo `externalId`/`scrydexId` is unverified (see Identifier row / ID-mapping note). |
| **Identifier** | requests MUST use the **Scrydex card ID returned by the Scrydex card response**. The existing resolver (`resolveScrydexCard`) resolves a card by name + number/set, reads the response `id` field (`me55c-4`), returns it as `scrydexId`, and uses THAT returned id for the subsequent by-id fetch. The resolver proves only that the returned id is what the by-id fetch consumes; it does NOT compare that id to `Card.externalId`, so it does NOT establish whether the returned id equals or differs from `externalId`. Mapping to Dojo `externalId`/`scrydexId` is therefore **unverified**. See the ID-mapping note. |
| **Tiers in `variants[].prices[]`** | `type:"raw"` = ungraded; graded entries carry `type != "raw"`, `company` (`PSA`/`CGC`/`BGS`/...) and `grade`. DOC-VERIFIED shape (contracts sample + price_history object). |
| **Credit cost** | 1 credit / request (DOC-STATED). |

> **ID mapping — UNVERIFIED (do not assume either way).** The docs do not state which Dojo
> identifier equals the Scrydex path id, and the code does not settle it:
> - What the resolver (`src/lib/services/scrydex.service.ts`) PROVES: it reads the `id`
>   field from the Scrydex card response, returns it as `scrydexId`, and uses that same
>   returned id for the by-id fetch. That is all it proves.
> - What the resolver does NOT prove: it never compares the returned id to `Card.externalId`,
>   so it establishes neither that they are equal NOR that they differ. Any claim that the
>   Scrydex id "is" or "is not" `externalId` is unsupported.
> - The `/price_history` and `/listings` doc examples use ids (`xy1-1`, `zsv10pt5-105`) in a
>   different-looking style from the `/cards` example (`me55c-4`), but surface style is not
>   proof of a mapping either.
> **Before wiring P1/P2**, verify empirically: first inspect the existing resolver and the
> IDs already stored in Postgres (`Card.externalId`, `Card.scrydexId`) for a known card — a
> no-cost local check that may already answer whether the stored `scrydexId` equals
> `externalId`. Only if that is inconclusive, run the smallest single-card live check (see
> L0). Do not claim a mapping in code or docs until confirmed.

### 1b. PRICE HISTORY — endpoint EXISTS (correction #1, supersedes prior report)

The prior report wrongly claimed Scrydex has no history endpoint and that charts could
only accumulate from future snapshots. **That is incorrect and is retracted.** Scrydex
documents a real historical time-series endpoint:

| Field | Value |
|---|---|
| **Endpoint (GET)** | `GET https://api.scrydex.com/pokemon/v1/cards/{id}/price_history` | 
| **Status** | **DOC-VERIFIED** (official page read this revision; see Sources) |
| **Path param** | `id` (required) — the **Scrydex card ID returned by the Scrydex card response**; mapping to Dojo `externalId`/`scrydexId` is unverified (official example uses `xy1-1`). See the ID-mapping note. |
| **Query filters** | `days` (int, days back from today), `start_date` / `end_date` (`YYYY-MM-DD`), `variant`, `condition` (`NM`/`LP`/`MP`/`DM`), `company` (grading company), `grade`, `is_perfect` (bool, e.g. PSA 10), `is_error` (bool), `is_signed` (bool), `page`, `page_size` |
| **Response (per-point fields SEEN in the doc sample)** | `{ data: [ { date: "YYYY-MM-DD", prices: [ { variant, condition, is_perfect, is_signed, is_error, type, low, market, currency } ] } ], page, page_size, count, total_count }`. **IMPORTANT:** the official sample showed ONLY `type:"raw"` points and did NOT show `company` or `grade` fields on any point. Whether graded history points carry identifiable `company`/`grade` labels in the RESPONSE (vs only accepting them as request FILTERS) is **UNRESOLVED**. |
| **Credit cost** | 3 credits / request (DOC-STATED; CORROBORATED) |

**Implications for the migration (overrides prior design assumptions):**

- **Backfill is real, not synthetic.** Charts can be populated from genuine historical
  points returned by `/price_history` — we do NOT depend on accumulating future snapshots,
  and we do NOT synthesize points from trend deltas. The `scrydex-trend` derived backfill
  stays slated for removal (Req 7.2) because real history is now available from the API;
  this strengthens, not weakens, the "no fabricated points" rule (Req 7.3).
- **RAW chart = Near Mint:** filter `condition=NM` (and the raw `type`) for the RAW NM
  series; the "every raw condition current price beneath" requirement reads the other
  conditions' current prices from the card object (1a), not from history.
- **PSA / BGS separate views — DRAWABILITY UNRESOLVED.** The endpoint ACCEPTS `company` and
  `grade` as request filters, but the sample response did not show those labels on the
  returned points. Two things are therefore unresolved and must be confirmed before building
  graded charts: (a) whether a graded-filtered call returns points that are identifiably
  labeled by company/grade in the response, and (b) whether ONE unfiltered call returns
  identifiable RAW/PSA/BGS grade series together (so they can be split client-side) or
  whether each series requires its own filtered call. The documented filters alone do NOT
  establish the response fields needed to DRAW separate PSA/BGS grade series.
- **Source-native currency preserved:** each history point carries its own `currency`
  (USD/JPY documented). History points are stored and charted source-native and are NEVER
  FX-converted (Req 9.3).
- **Pagination / credit cost:** `page` / `page_size` on history; `days` or
  `start_date`/`end_date` bound the range. One history request = 3 credits. Because the
  per-call grade-series behavior is unresolved (above), the per-detail-open credit cost is
  also unresolved: it is one 3-credit call IF a single unfiltered call yields all
  identifiable series, or up to N × 3 credits if each grade series needs its own filtered
  call (see Remaining live checks L2).

### 1c. RAW / PSA / BGS tier availability per game (Reqs 1.4, 1.5)

Tiers are entries in the same `prices[]` (current) and `price_history` (historical)
payloads, decoded by `type:"raw"` vs `company`/`grade`.

| Game | RAW | PSA | BGS | Status |
|---|---|---|---|---|
| Pokémon | documented (`type:"raw"`, conditions NM/LP/MP/DM) | documented (`company:"PSA"` + `grade`) | documented as a possible `company` value | DOC-VERIFIED that the schema supports all three; whether a GIVEN card carries PSA/BGS entries is per-card. A card with no graded entry is a genuine per-card GAP (accessor returns null -> UI "—"). |
| One Piece | documented | documented | not in population coverage (PSA English only) | One Piece routes are publicly documented; whether OUR account has data access/coverage is unconfirmed. Population follows the PSA-English-only limit. See Remaining live checks. |

**Important coverage limit (population vs price tiers are different things):** the price
schema can carry graded PRICE entries for multiple companies (PSA/BGS/CGC), but POPULATION
coverage is narrower. Scrydex's current public coverage table lists **PSA English only**
for population reports. Therefore:
- **BGS population: treat as UNSUPPORTED** under current public coverage (not just a
  per-card gap — it is not in the coverage table). Do not build a BGS population view that
  implies data exists; render the fallback state.
- **PSA population: conditionally supported** — requires `include=pop_reports` AND
  card-level availability (a given card may still have none). PSA English only; non-English
  PSA population is also outside the listed coverage.
- Graded PRICE/history for BGS may still exist independently of population — keep the price
  question (data-dependent per card) separate from the population question (coverage-limited
  to PSA English).

---

## Area 2 — Scanner / Vision identify (correction #2, supersedes candidate-path list)

The prior report framed Vision as an UNRESOLVED endpoint with a guessed candidate-path
list. **That framing is retracted.** Scrydex documents the Vision identify endpoint:

| Field | Value | Status |
|---|---|---|
| **Endpoint** | `POST https://api.scrydex.com/vision/v1/cards/identify` | DOC-VERIFIED (official Vision page read this revision — see Sources) |
| **Two request modes** | (a) JSON `{ image_url, games? }` fetches a public URL; (b) `multipart/form-data` with `image` (binary file) + optional `games` (comma-separated) for direct upload | DOC-VERIFIED |
| **Max upload size** | 20 MB (docs recommend 1500–2500px longest side; 200–500 KB optimized is faster) | DOC-VERIFIED (aligns with Dojo's own Req 11.1 server cap) |
| **Supported formats** | JPEG, PNG, WebP | DOC-VERIFIED |
| **Credit cost** | 5 credits / request (standard metadata is 1) | DOC-VERIFIED |
| **Response timing** | typically 1–3 seconds | DOC-VERIFIED |
| **Response fields** | `data.analysis` (`type` raw/graded, `game`, `language_code`, optional `graded_details`: `company`, `grade_code`, `grade_label`, `grade_number`, `year`, `cert`) and `data.matches[]` (`score` ~0.7–1.3+, optional `variant`, `card` = standard Card object), plus `page_size`, `count`, `total_count` | DOC-VERIFIED |
| **Grading detection** | reads slab grading for PSA, BGS, CGC, TAG; multi-TCG (pokemon, lorcana, magicthegathering, onepiece, riftbound, gundam) scoped via `games` | DOC-VERIFIED |
| **No-match behavior** | the sample shows a populated `matches[]`; whether an EMPTY `matches[]` (200) vs an error is returned for no-match is not shown | DOC-STATED (confirm in P4) |
| **Provider image retention** | whether Scrydex stores/retains the uploaded image after identify is NOT stated — Terms section 8 grants a processing license "to operate/secure/improve" the Services without a stated retention period | PROVIDER QUESTION (clarify in writing) |
| **Secrets** | identify is called server-side only; `X-Api-Key` + `X-Team-ID` never reach the browser | design rule (Req 10.7) |

**App discard vs provider retention — keep these separate.** Dojo's OWN behavior is to use
the uploaded image only for the scan and then discard it (Req 11.3) — it is never written to
the portfolio or persistent storage on our side. That is a Dojo guarantee about Dojo's
storage. It says NOTHING about what Scrydex does with the image after it receives it: under
Terms section 8 the user retains ownership but grants Scrydex a processing license, with no
stated retention/deletion period. Treat Scrydex-side retention as an open PROVIDER QUESTION
to confirm in writing (fits the commercial-authorization gate below), and do not represent
"image discarded" to end users as if it covers the provider.

Notes:
- The guessed candidate paths (`/v1/vision`, `/pokemon/v1/vision/identify`, etc.) from the
  prior report are removed as the main open question. The real documented path is
  `/vision/v1/cards/identify` (game-agnostic `vision/v1`, not under `/pokemon/v1`).
- Dojo still enforces its OWN server-side guards regardless of Scrydex's limits: reject
  > 20 MB (Req 11.1) and validate actual MIME against the JPEG/PNG/WebP allow-list
  (Req 11.2) before dispatching the (5-credit) identify call, so a bad upload never burns
  credits. Image is discarded after scanning (Req 11.3).
- A failed/no-match identify must NOT consume the user's lifetime scan allowance (Req 10.5)
  — but note the Scrydex credit for the call itself may still be billed (see credit model;
  failed-call billing is ACCOUNT-SPECIFIC). These are two different counters.
- Response field names ARE now documented (see the table). The one remaining PENDING item is
  the no-match shape: whether an empty `matches[]` (HTTP 200) vs an error is returned — the
  sample only shows a populated match. Confirm in P4 (L5).
- **Vision grading detection (PSA/BGS/CGC/TAG) is separate from population coverage.** Vision
  reading a slab''s company/grade off an image does NOT imply Scrydex has POPULATION data for
  that company — population remains PSA-English-only per the coverage table (see Area 4b).

---

## Area 2b / Area 4 — SOLD listings (correction #3, supersedes "sold-comps GAP")

The prior report recorded sold comps as an unconfirmed GAP. **Scrydex documents a sold
listings endpoint** for Pokémon:

| Field | Value | Status |
|---|---|---|
| **Search listings (GET)** | `GET https://api.scrydex.com/pokemon/v1/cards/{id}/listings` | DOC-VERIFIED |
| **Single listing (GET)** | `GET https://api.scrydex.com/pokemon/v1/listings/{id}` | DOC-VERIFIED |
| **Path param** | the **Scrydex card ID returned by the Scrydex card response**; mapping to Dojo `externalId`/`scrydexId` is unverified (official example `zsv10pt5-105`). See the ID-mapping note. | DOC-VERIFIED (path shape); ID MAPPING UNVERIFIED |
| **Filters** | `days` (days since sold), `source` (e.g. `ebay`), `variant`, `grade`, `company`, `condition`, `is_perfect`, `is_error`, `is_signed`, `page`, `page_size`, `select`, `include` | DOC-VERIFIED |
| **Listing fields** | `id`, `source` (e.g. ebay), `card_id`, `title`, `variant`, `company`, `grade`, `is_perfect`, `is_error`, `is_signed`, `url`, `price` (sold price), `currency`, `sold_at` (`YYYY/MM/DD`) | DOC-VERIFIED |
| **Credit cost** | 1 credit / request (standard) (DOC-STATED) |

Implications:
- This is the data source for replacing "Sellers on the Floor" with **real recent SOLD
  records** on card detail (spec P2 / task 3.5). `price` + `sold_at` + `source` are the
  sold-record fields; filter `source=ebay` for eBay sold comps, `days=N` for recency.
- These are SOLD records (have `sold_at`), satisfying the "never fall back to active
  listings" rule. If a card returns zero listings, the UI shows "No recent sales found"
  (never active listings).
- **One Piece sold listings:** the listings endpoint confirmed above is under
  `/pokemon/v1/...`. One Piece routes are publicly documented in general, but
  **One Piece sold-listing parity is UNRESOLVED** — do not assume `/onepiece/v1/cards/{id}/listings`
  exists or returns sold records until the relevant OFFICIAL One Piece listings doc confirms
  it. Until then treat One Piece sold records as a possible GAP; if absent, One Piece detail
  shows "No recent sales found" (never active listings).

---

## Area 4b — PSA/BGS population reports (correction #4)

The prior report treated the empty `pop_reports: []` in a sampled card as evidence of
missing coverage. **That inference was wrong** and is retracted.

| Field | Value | Status |
|---|---|---|
| **Coverage** | current public coverage table lists **PSA English only** for population | DOC-STATED (coverage page; confirm in browser) |
| **How to request** | population is returned only with `include=pop_reports`; combinable, e.g. `include=prices,pop_reports` | DOC-STATED |
| **BGS population** | **UNSUPPORTED** under current public coverage (not in the table) | DOC-STATED |
| **Why the sample was empty** | the contracts sample was fetched WITHOUT `include=pop_reports`, so `pop_reports: []` is expected-absent, not absent-coverage | DOC-VERIFIED (sample used `include=prices` only) |
| **Credit cost** | standard 1 credit / request (population is not an AI feature) | DOC-STATED |

Implications:
- **BGS population is not available** from current public coverage — the UI must render the
  fallback state for BGS population and must not imply a value exists. (BGS graded PRICE is
  a separate, data-dependent question.)
- **PSA population is conditionally supported:** PSA English only, requires
  `include=pop_reports`, and is still subject to card-level availability (a given card may
  have none). An empty `pop_reports` WITH the include on a PSA English card = genuine
  per-card gap; an empty one WITHOUT the include proves nothing.
- Population stays **manual-refresh only** (Req 15) — never on page load/search/sync — and
  when unrefreshed/unsupported the UI shows a fallback state, never a fabricated number
  (Req 15.3).

---

## Currency / FX implications (correction #7)

Scrydex documentation lists **USD and JPY** pricing and states **EUR support is still
being developed** (DOC-STATED).

Consequences for the app's USD/EUR profile display and source-native charts:

- **Source-native charts are unaffected in principle:** history/listing points are stored
  and charted in their own `currency` (USD or JPY) and never converted (Req 9.3). A JPY
  card charts in JPY.
- **Current-price display conversion is the only place FX applies** (Req 9.2). Because
  Scrydex does not reliably emit EUR today:
  - USD profile: for USD-source prices, no conversion; for JPY-source prices, convert
    JPY->USD via the documented daily FX provider.
  - EUR profile: Scrydex EUR being "in development" means we should NOT assume a native EUR
    price field. EUR display requires converting from the source currency (USD or JPY)
    ->EUR via our own FX service. This makes the FX_Service MORE load-bearing for EUR
    users, not less.
- **FX failure behavior (Req 9.4/9.5):** if the FX rate is unavailable, show the
  source-native current price and flag conversion unavailable — never fabricate a converted
  number. The FX provider + cache-and-failure behavior is documented in the P1 design
  (`fx.service`), independent of Scrydex.
- **Watch item:** when Scrydex ships EUR natively, revisit whether to prefer the native EUR
  field over our converted value. Tracked as a non-blocking follow-up.

---

## PRODUCTION LEGAL / COMMERCIAL-USE BLOCKER (correction #6) — action required

**This is a production blocker, not a code task.** Scrydex's Terms of Service
(DOC-VERIFIED, read this revision) restrict commercial exploitation and redistribution of
the Services without prior written authorization. Relevant clauses:

- **Terms section 4** — users agree NOT to "Resell, sublicense, redistribute, mirror, or
  commercially exploit the Services without prior written authorization from Scrydex," and
  NOT to "Use the Services primarily as a substitute backend, proxy, or wholesale data
  source for a competing commercial product or service without written authorization."
- **Terms section 8** — the user retains ownership of uploaded images (User Content) and
  grants Scrydex a license to process them "solely for the purpose of operating, securing,
  improving, and providing the Services." (Relevant to scanner uploads.)
- **Terms section 9** — third-party card data/metadata/trademarks remain the property of
  their owners; Scrydex does not grant rights by implication.
- **Terms section 12** — Scrydex is not responsible for data retention; we keep our own
  backups (we already persist to Postgres as source of truth).
- **Governing law:** State of Wisconsin, USA.

**Exact written permissions to obtain from Scrydex BEFORE commercial/production launch:**

1. **End-user display** — permission to display Scrydex-sourced card data, prices, history,
   population, and sold listings to Dojo's end users in a commercial app.
2. **Database storage / cache** — permission to store and cache Scrydex responses in our
   own database (Postgres source of truth + optional Redis cache) rather than fetching live
   each time.
3. **Bulk ingestion** — permission to bulk-ingest catalog/price data (the daily sync /
   bulk refresh), given section 4's limits on wholesale/substitute-backend use and
   section 7's "atypical usage" controls.
4. **Post-cancellation retention / use** — written clarity on whether we may retain and
   continue to use already-ingested Scrydex data after we stop paying / cancel, and under
   what conditions it must be purged.
5. **(Scanner) Provider image retention** — written clarity on whether/how long Scrydex
   retains images uploaded to Vision identify. This is separate from Dojo's own discard
   (Req 11.3) and from end-user display; it is a privacy/data-handling clarification tied to
   Terms section 8's processing license.

Until these are confirmed in writing, do not launch commercially on Scrydex data and do not
run a bulk ingestion that could be read as "wholesale/substitute backend" use. This gate is
independent of, and additional to, the Checkpoint D credit-cost gate.

---

## Areas 3 & 5 — Portfolio accounting / Dashboard (unchanged, no direct Scrydex calls)

- **Area 3 (Portfolio sales & accounting):** no direct Scrydex endpoints; P&L math runs over
  stored prices. Depends on Area 1 current price (cost-basis snapshot) and `/price_history`
  (nearest historical price for lazy cost-basis resolution). No new GAP.
- **Area 5 (Dashboard/collections/onboarding):** no Scrydex calls at render; totals/series
  computed from stored Scrydex-sourced points. Onboarding persistence is DB-only. No GAP.

---

## Remaining live checks (correction #8) — require owner approval before any call

Each row lists the exact request, its purpose, the expected MAXIMUM documented credits, how
usage is measured, and why documentation alone cannot answer it. **Do not dispatch any of
these without explicit owner approval.** Credit figures use documented list costs
(1 standard / 3 history / 5 vision); failed-request billing is treated as NON-free.

**Measurement note (important):** documented credit usage refreshes only every ~20–30 min,
so an immediate before/after balance diff CANNOT attribute cost to a single request. Use a
DELAYED reading (record balance, run the bounded pass, then re-read after the refresh window)
or get provider confirmation of per-op cost. Keep the whole pass under 100 req/s and spaced
to avoid Cloudflare throttling.

| # | Exact request | Purpose | Max credits (documented) | Measurement | Why docs cannot answer |
|---|---|---|---|---|---|
| L0 | **Local first (no API, no credits):** inspect the resolver and the IDs already stored in Postgres for a known card (`Card.externalId` vs cached `Card.scrydexId`) — this may already answer the mapping. **Only if inconclusive:** the smallest single-card live check — ONE candidate id against `/cards/{id}`, `/cards/{id}/price_history`, `/cards/{id}/listings` | **Resolve the ID-mapping question** — which Dojo id each path accepts | **up to 5 credits per candidate id** (1 card + 3 history + 1 listings). Each ADDITIONAL candidate id tried multiplies this: 2 ids = up to 10, 3 ids = up to 15. Propose the smallest check (one id) and its max cost for approval BEFORE dispatching. | local inspection = 0; then delayed reading for any live call | docs don't state the mapping; the resolver proves only that the returned id feeds the by-id fetch, not its relation to `externalId` |
| L1 | `GET /onepiece/v1/cards?q=name:luffy&pageSize=1&include=prices` | Confirm OUR account's One Piece data access/coverage (routes are documented) | 1 | delayed reading | docs show the routes; our account's coverage is not documented |
| L2 | `GET /pokemon/v1/cards/{id}/price_history?page_size=1` on one known card | Confirm history returns real points for OUR account + whether omitting company/grade returns all tiers in one call (credit-combining) | 3 | delayed reading | docs show the schema, not whether one call spans RAW+PSA+BGS or needs N calls |
| L3 | `GET /pokemon/v1/cards/{id}/listings?source=ebay&page_size=1` | Confirm sold records exist for a sample card + field population | 1 | delayed reading | coverage per card is data-dependent, not documented |
| L4 | `GET /pokemon/v1/cards/{id}?include=prices,pop_reports` on a PSA-English card | Confirm PSA population populates with the include set | 1 | delayed reading | empty-without-include is expected; real coverage needs the include |
| L5 | `POST /vision/v1/cards/identify` with ONE small valid JPEG | Confirm identify response field names + no-match behavior | 5 | delayed reading; one image only | response field names + no-match status code not fully specified in retrievable docs |
| L6 | (observation during L0–L5) note any `Retry-After` / rate-limit headers | Characterize real rate-limit behavior vs the documented 100 req/s | 0 extra | n/a | the 100 req/s ceiling is documented; real header behavior is not |

**Total worst-case for one pass of L1–L5: ~11 credits** (1+3+1+1+5). **L0 is separate and
multiplies per candidate id: up to 5 credits per id** (1 card + 3 history + 1 listings), so
the smallest viable L0 check is one id at ≤5 credits; trying all three candidate ids would be
≤15. Prefer the local (zero-cost) inspection first and propose a single-id live check only if
needed. All of this is still a trivial, bounded probe — distinct from the separately-gated
BULK refresh (Checkpoint D, task 2.14), which scales with catalog size and must be estimated
and approved on its own. Credit totals here are documented-cost estimates; actual spend is
confirmed only by the delayed reading (`/account/v1/usage`, ~20–30 min lag) or provider
confirmation (never an immediate diff).

**Provider questions (no API call — ask Scrydex in writing):** Scrydex-side image retention
after Vision identify; failed-request (4xx/5xx) billing; the four commercial-authorization
permissions below.

---

## Genuine unresolved questions (short list)

1. **ID mapping** — which Dojo id does each Scrydex path (`/cards/{id}`, `/price_history`,
   `/listings`) accept? The resolver proves only that the returned Scrydex `id` feeds the
   by-id fetch; it does NOT establish whether that id equals or differs from `Card.externalId`.
   Verify by local inspection of stored IDs first, then L0 if needed. (L0)
2. **One Piece account coverage** — the routes are publicly documented; does OUR account
   have data access/coverage, and does One Piece sold-listing parity exist in official docs?
   Unresolved until confirmed. (L1, L3)
3. **History graded series — labeling AND combining** — (a) do graded `/price_history`
   points carry identifiable `company`/`grade` labels in the RESPONSE (the sample showed
   only raw points, none)? and (b) does one unfiltered call return RAW+PSA+BGS together
   (one 3-credit call) or does each series need its own filtered call (N × 3)? Both are
   needed before graded charts can be drawn, and both drive per-detail-open credit cost. (L2)
4. **PSA population per-card availability** — PSA English is the only documented population
   coverage (BGS unsupported); confirm a given card actually returns pop with
   `include=pop_reports`. (L4)
5. **Vision no-match shape** — response field names ARE documented (`data.analysis` +
   `data.matches[]`); the one open item is whether a no-match returns an empty `matches[]`
   (HTTP 200) or an error. (L5)
6. **Scrydex-side image retention** — does Scrydex keep the uploaded image after identify,
   and for how long? Provider question, distinct from Dojo's own discard. (ask in writing)
7. **Failed-request billing** — are 4xx/5xx responses billed? Needed for honest budget;
   not measurable by immediate before/after (20–30 min usage refresh). (provider / delayed)
8. **Our plan's monthly allotment + overage pricing** vs the documented 100 req/s ceiling —
   ACCOUNT-SPECIFIC. (dashboard)
9. **EUR availability timeline** — Scrydex EUR is "in development"; revisit FX preference
   for EUR users when it ships natively.
10. **Written commercial authorization** — the four permissions below (end-user display,
    caching/storage, bulk ingestion, post-cancellation use). Legal, not technical.

---

## Sources

Official Scrydex pages read directly during this revision (DOC-VERIFIED):

- **Price history** — https://scrydex.com/docs/pokemon/price-history
  (`GET /pokemon/v1/cards/{id}/price_history`; filters days/start_date/end_date/variant/
  condition/company/grade/is_perfect/is_error/is_signed/page/page_size; response shape — the
  sample showed only `type:"raw"` points, no company/grade labels on points)
- **Listings** — https://scrydex.com/docs/pokemon/listings
  (`GET /pokemon/v1/cards/{id}/listings` + `GET /pokemon/v1/listings/{id}`; sold-record
  fields incl. price/currency/sold_at/source; filters)
- **Vision (API Reference / Overview)** — https://scrydex.com/docs/vision/overview
  (`POST /vision/v1/cards/identify`; JSON `image_url` mode + `multipart/form-data` `image`
  file mode; `games` scope; JPEG/PNG/WebP; 20 MB; 5 credits; 1–3s; response `data.analysis`
  + `data.matches[]`; grading detection PSA/BGS/CGC/TAG. Image retention NOT stated.)
- **Rate Limits** — https://scrydex.com/docs/getting-started/rate-limits
  (100 requests/second across all plans, 429 on exceed; credit-based limits; overage fees;
  **usage updates every 20–30 minutes**; `/account/v1/usage` returns total_credits/
  remaining_credits/used_credits/overage_credit_rate; caching "highly encouraged")
- **Terms of Service** — https://scrydex.com/terms
  (section 4 commercial-use/redistribution restriction; section 6 fees/credits; section 7
  Fair AI Usage / higher AI credit rates / quotas; section 8 User Content image license;
  section 9 third-party IP; section 12 data retention; Wisconsin governing law)
- **Docs landing** — https://scrydex.com/docs

Official pages cited by path but NOT retrievable to a plain fetch this revision (the docs
site renders these client-side and 404 to a plain HTTP GET; DOC-STATED — open in a browser
to confirm field-level specifics):

- **Population reports** — population object + `include=pop_reports` and the coverage table
  listing **PSA English only** (BGS/other graders and non-English PSA not listed). Likely
  under `https://scrydex.com/docs/pokemon/...` (population) and a getting-started coverage
  page; confirm the exact slugs in a browser.
- **Per-op credit split (1 / 3 / 5)** — the Rate Limits page (verified) confirms the
  credit-based model and the Vision page (verified) confirms Vision = 5 / standard = 1. The
  **3-credit price-history figure specifically** is still DOC-STATED/CORROBORATED pending a
  direct per-endpoint credit page.

Secondary corroboration (CORROBORATED, not authoritative):

- Credit split 1/3/5 and monthly allotment — https://github.com/mgzwarrior/mgz-pkmn/issues/368

Internal evidence:

- `.agents/tasks/api-integration-contracts.md` — live-probed card shape. It records the
  Scrydex card response field exactly as `"id": "me55c-4"` inside a `Card` object (marked
  VERIFIED); it does NOT label that value `externalId` or assert any mapping to a Dojo id.
  It also records the raw/graded tier encoding and `pop_reports: []` fetched without the
  `include`, plus the two-header auth confirmation. Any externalId/scrydexId wording here is
  THIS report's interpretation, not a claim made by the contracts file.

> **Compliance note.** External source content above was summarized and paraphrased for
> licensing compliance; endpoint paths, field names, and credit figures are factual
> identifiers quoted minimally for technical accuracy.



















