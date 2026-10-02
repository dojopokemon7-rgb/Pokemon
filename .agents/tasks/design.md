# Technical Design — External API Integration (catalog, pricing, charts, scanning, PSA grading)

Grounded in the verified contracts (`.agents/tasks/api-integration-contracts.md`),
the requirements (`.agents/tasks/requirements.md`), and `AGENTS.md`. **This is REVISION 3** —
Revision 2 resolved the first review (5 HIGH, 5 MEDIUM, 3 NIT; see §13). Revision 3
resolves the SECOND review in `.agents/tasks/design-review.json` (2 HIGH, 2 MEDIUM,
3 NIT) — chiefly the Scrydex native-id resolution (§3.2a) and the apitcg `images`-array
shape (§4). See §14 for the point-by-point response to the second review.

---

## 0. Overview

Dojo already has the scaffolding for this work, but it was written against guessed
contracts. The live-probed contracts prove the guesses wrong in specific ways:
PokéWallet is `api.pokewallet.io` with `X-API-Key` (not `.com/v1` + Bearer); Scrydex
needs **both** `X-Api-Key` + `X-Team-ID` and has **no history endpoint** (prices live
inline in `variants[].prices[]` with rolling `trends` deltas). This design rewrites
the two service clients to the real shapes, turns the "store once / reuse / grow over
time" requirement into concrete `PricingHistory` + `CurrentPrice` writes gated by a
freshness window and metered through `SyncLog`, wires the sync engine's price
fallbacks (TCGdex→PokéWallet for Pokémon, apitcg catalog + BerryWallet pricing for
One Piece), routes PSA graded pricing through Scrydex with the existing curated/cert
fallback, and converts the dashboard + card-detail charts to the real stored series.

The guiding non-negotiable is **never fabricate data** (AGENTS.md §5.2): a missing
real value is `null` → UI renders "—". The one sanctioned derived series is the
Scrydex trend-delta backfill, explicitly labelled `source = "scrydex-trend"`.

### 0.1 Resolution of blocking Open Question #0 (worktree vs mainline state)

**Decision: treat the uncommitted mainline working tree as the authoritative
scaffold and bring it into the worktree verbatim as the starting point, then rewrite
on top of it.** Investigation confirms the enriched schema and all scaffold files
exist and are self-consistent on the main checkout (`d:\…\Pokemon`, commit `022233c`):

- `prisma/schema.prisma` already contains `Game`, `DataSource`
  (`TCGDEX`/`POKEWALLET`/`SCRYDEX`), `Card.game` + `Card.source`, the enriched
  `PricingHistory` (`priceMarket`, `priceLow`, `source` free-text, `currency`,
  `variant`, `condition`, unique `[cardId, recordedAt, source, currency, variant,
  condition]`), the new `CurrentPrice` (unique `[cardId, source, currency, variant,
  condition]`, `source` is the `DataSource` **enum**), and `SyncLog` (`job`, `cardId`,
  `status`, `credits`, `error`, `ranAt`). **Verified by reading the file.**
- `src/lib/services/{scrydex,pokewallet,tcgdex}.service.ts`, `scripts/scrydex-backfill.ts`,
  `src/app/api/users/me/collection/history/route.ts`, `src/app/api/cards/[id]/prices/route.ts`,
  and the modified `DashboardClient.tsx` / `search/[id]/page.tsx` / `recognize/route.ts`
  / `sync-cards.service.ts` / `cards/[id]/history/route.ts` all exist and were read.

**Setup action (one instruction, NIT-11 resolved).** Copy the following untracked
paths from the main checkout (`d:\…\Pokemon`) into the worktree
(`d:\…\.worktrees\api-integration`), preserving their relative paths — nothing more:
`prisma/schema.prisma` (modified), `src/lib/services/{scrydex,pokewallet,tcgdex}.service.ts`,
`scripts/scrydex-backfill.ts`, `src/app/api/users/me/collection/history/route.ts`,
`src/app/api/cards/[id]/prices/route.ts`, `src/app/api/cards/[id]/history/route.ts`,
`src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`,
`src/app/(dashboard)/search/[id]/page.tsx`, `src/app/api/cards/recognize/route.ts`,
`src/lib/services/sync-cards.service.ts`. Because they are untracked (not committed) on
main, `git checkout` cannot fetch them — use a plain file copy. This is the starting
point onto which the rewrites in §2–§8 are applied.

**Two additive schema edits layered on the imported schema (review-2 findings #1/#7).**
Before the `db:push` below, add to the imported `schema.prisma`: (1) a nullable
`scrydexId String? @unique` column on `Card` (caches the resolved Scrydex-native id,
§3.2a), and (2) `@@index([job, cardId, ranAt])` on `SyncLog` (backs the freshness-gate
query, §3.6). Both are additive — no drops, no narrowing — so they fold into the single
non-destructive push.

**Prisma migration scope.** The enriched schema is a real DDL change (3 new
tables/columns + 2 enums, plus the two additive edits above). The repo convention is Supabase remote with
`db:push`/`db:migrate`. e2e boots a production build against a reachable
`DATABASE_URL` and the new routes query `currentPrice`/`pricingHistory`/`syncLog`, so
**the schema MUST be applied to the DB before e2e can pass.** Decision: run
`npm run db:push` against the remote Supabase DB in the worktree before e2e (push, not
a versioned migration, matches the "remote dev DB" workflow already in `package.json`
and avoids a migration-history divergence between worktree and main; a formal
`migrate dev` can be squashed in on the final rebase to main). The design flags this
as a **medium-risk shared-system action** (it alters the live dev DB) that the
implementation step must call out when it runs it. The three new tables/columns and 2
enums are **additive** (no column drops, no type narrowing), so the push is
non-destructive. **Rollback expectation (NIT-12):** if the push must be reverted, the
reversal is to `DROP TABLE current_price, sync_log; ALTER TABLE pricing_history DROP
COLUMN price_market, price_low, source, currency, variant, condition` (restoring the
single `price` column), `ALTER TABLE "card" DROP COLUMN game, source, "scrydexId"`
(the `scrydexId` column added in §3.2a for Scrydex-id caching), and
`DROP TYPE "Game", "DataSource"` — the new `SyncLog` `@@index([job, cardId, ranAt])`
(§3.6) drops with its table. All of these are **additive** (new tables, new nullable
columns, a new index, two new enums — no column drops, no type narrowing), so the push
is non-destructive. All data loss on reversal is confined to the new/added columns,
which hold only re-derivable pricing snapshots, so a rollback loses no source-of-truth
data (consistent with AGENTS.md: Scrydex pricing is reconstructable by re-pulling).

---

## 1. Technology stack (locked)

No new runtime dependencies. Everything below is already in `package.json`:
Next.js 15 App Router, React 19, TypeScript 5 (strict), Prisma 6 + PostgreSQL
(Supabase), Zod 3, TanStack Query v5, Vitest + Playwright, native `fetch`. OCR keeps
tesseract.js (client) + the existing `vision-ocr.service.ts` Google Vision path; this
task **adds** Scrydex Vision as a server-side signal but introduces no new OCR
library. No HTTP client library is added — `fetch` with explicit headers only.

---

## 2. `pokewallet.service.ts` — rewrite (PRICING ONLY) · FR-1

### 2.1 Public interface

```ts
const POKEWALLET_BASE_URL = "https://api.pokewallet.io";   // was .com/v1 — WRONG

function pokeWalletHeaders(): HeadersInit {
  const key = process.env.POKEWALLET_API_KEY;
  if (!key) throw new Error("POKEWALLET_API_KEY is not set.");
  return { "X-API-Key": key };                              // was Authorization: Bearer — WRONG
}

export interface OnePiecePrice { market: number | null; low: number | null; currency: string; }

/** One Piece price for every card in a set, keyed by card_number ("OP01-001").
 *  GET /op/sets/{setCode}?page=1&limit=200 — the free-tier surface. */
export async function fetchOnePieceSetPrices(setCode: string): Promise<Map<string, OnePiecePrice>>;

/** Pokémon price GAP fallback by card name. GET /search?q=<name>. */
export async function fetchPokemonCardPrice(name: string): Promise<OnePiecePrice | null>;
```

**Removed entirely** (dead/guessed endpoints per contracts): `/prices/pokemon/{id}`,
`/one-piece/sets`, `/one-piece/sets/{id}/cards`, and the `fetchOnePieceSets` /
`fetchOnePieceCards` catalog functions. Catalog is NOT this service's job (One Piece
catalog stays apitcg; see §4). The old `fetchPokemonCardPrice(cardId)` signature
changes from an id to a **name** because the real surface is `GET /search?q=<name>`,
not `/prices/pokemon/{id}`.

### 2.2 Zod schemas mapping the REAL shapes

```ts
// /op/sets/{code} card entry — tcgplayer is null on CM-only (negative group_id) sets.
const OpTcgPlayerSchema = z.object({
  prices: z.object({
    low_price: z.number().nullish(),
    market_price: z.number().nullish(),
    high_price: z.number().nullish(),
  }).nullish(),
}).nullable();                                   // ← the whole object is null on CM-only sets

const OpCardMarketSchema = z.object({
  prices: z.object({ avg: z.number().nullish(), low: z.number().nullish(), trend: z.number().nullish() }).nullish(),
}).nullish();

const OpCardSchema = z.object({
  id: z.string(),
  card_number: z.string(),                       // "OP01-001" — the key we map on
  name: z.string().optional(),
  tcgplayer: OpTcgPlayerSchema,                  // nullable, handled below
  cardmarket: OpCardMarketSchema,
});

const OpSetResponseSchema = z.object({
  success: z.boolean().optional(),
  set: z.object({ set_code: z.string(), group_id: z.number().optional() }).optional(),
  data: z.array(OpCardSchema),
});

// /search?q= Pokémon fallback — reuse the same tcgplayer/cardmarket price block.
const PwSearchResultSchema = z.object({
  tcgplayer: OpTcgPlayerSchema,
  cardmarket: OpCardMarketSchema,
});
const PwSearchResponseSchema = z.object({ data: z.array(PwSearchResultSchema) });
```

### 2.3 CM-only `tcgplayer: null` handling (AC-2)

The price picker is a pure helper so it is unit-testable in isolation:

```ts
function pickOnePiecePrice(card: z.infer<typeof OpCardSchema>): OnePiecePrice {
  const tp = card.tcgplayer?.prices;
  const market = num(tp?.market_price) ?? num(card.cardmarket?.prices?.avg) ?? null;
  const low    = num(tp?.low_price)    ?? num(card.cardmarket?.prices?.low) ?? null;
  return { market, low, currency: "USD" };
}
```

`num()` returns the value only when it is a finite number `> 0`, else `null`. A
CM-only card (`tcgplayer: null`) therefore falls through to `cardmarket`, and if that
too is empty returns `{ market: null, low: null }` — **never throws**. A normal card
returns a numeric `market_price`.

### 2.4 Error handling (per operation)

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `fetchOnePieceSetPrices` | HTTP !ok / network | yes | **empty `Map`** (no price gap filled) | `console.warn [pokewallet]` once |
| `fetchOnePieceSetPrices` | Zod parse fail on body | yes | empty `Map` | `console.warn` with issue summary |
| `fetchOnePieceSetPrices` | individual card fails `OpCardSchema` | yes | that card dropped, rest kept | debug only |
| `fetchPokemonCardPrice` | HTTP !ok / network / 0 results | yes | `null` | `console.warn` |

No path throws to the sync engine; a price gap simply stays `null` (NFR-4 graceful
degradation, NFR-8 keeps us under the 1,000 req/day free tier because the sync only
calls this for active cards, batched per-set once).

---

## 3. `scrydex.service.ts` — rewrite · FR-2 + FR-4

### 3.1 Public interface

```ts
const SCRYDEX_BASE_URL = "https://api.scrydex.com";

function scrydexHeaders(): HeadersInit {
  const key = process.env.SCRYDEX_API_KEY;
  const team = process.env.SCRYDEX_TEAM_ID;
  if (!key) throw new Error("SCRYDEX_API_KEY is not set.");
  if (!team) throw new Error("SCRYDEX_TEAM_ID is not set.");    // both required or instant 401
  return { "X-Api-Key": key, "X-Team-ID": team };              // was Authorization: Bearer — WRONG
}

function gameSlug(game: Game): "pokemon" | "onepiece";          // Prisma Game enum → path slug

export interface ScrydexRawPrice { market: number | null; low: number | null; currency: string;
  trends: { days_1?: TrendDelta; days_7?: TrendDelta; days_14?: TrendDelta } | null; variant: string; condition: string; }
export interface ScrydexGradedPrice { market: number | null; low: number | null; currency: string;
  company: string; grade: string; }
interface TrendDelta { price_change: number; percent_change: number }

/** FR-2d Vision identify result. FIELD NAME DECISION (resolves review finding #1):
 *  the id field is **`cardId`** and carries the EXTERNAL catalog id (NFR-3) — this is
 *  the name `recognize/route.ts` already reads (`scrydexResult.cardId`,
 *  `where: { externalId: scrydexResult.cardId }`), so the route stays UNCHANGED and
 *  only this interface is defined. We deliberately do NOT rename to `externalId`
 *  because that would force two edits in `recognize/route.ts` for zero benefit —
 *  the lazy, minimal-diff choice. The value is an externalId despite the field name;
 *  that is noted in the service doc-comment so nobody confuses it with `Card.id`. */
export interface ScrydexIdentifyResult { cardId: string; confidence: number; name: string; setCode: string; }

/** Resolve a Dojo card to a Scrydex-native card id by SEARCH (resolves review-2 finding #1).
 *  Scrydex uses its OWN catalog-id namespace (contracts example id "me55c-4"), which is
 *  NOT the TCGdex id stored in Card.externalId (e.g. "base1-4") NOR the Bandai code
 *  ("OP01-001"). So we never pass externalId to GET /{slug}/v1/cards/{id}. Instead we
 *  search by name and match on collector number + set, then use the matched entry's
 *  prices[] DIRECTLY (the search response already carries prices when include=prices,
 *  so NO second call — saves a credit).
 *  Returns the matched Scrydex card (incl. its prices) and its native id, or null. */
export async function resolveScrydexCard(
  card: { name: string; number: string; setName?: string; setCode?: string; game: Game }
): Promise<{ scrydexId: string; card: ScrydexCard } | null>;

/** Fetch a card incl. prices by its SCRYDEX-NATIVE id (used only after resolveScrydexCard
 *  has cached a scrydexId on the Card). GET /{slug}/v1/cards/{scrydexId}?include=prices */
export async function fetchScrydexCardById(scrydexId: string, game: Game): Promise<ScrydexCard | null>;

/** FR-2b: raw/NM market+low from the type=="raw" entry (first variant that has one). */
export function pickRawPrice(card: ScrydexCard): ScrydexRawPrice | null;

/** FR-2c: PSA graded entry matching a requested grade; null when absent. */
export function pickGradedPrice(card: ScrydexCard, grade: string | number, company?: string): ScrydexGradedPrice | null;

/** FR-2d: Vision identify — see §3.5. */
export async function identifyCard(imageBase64: string): Promise<ScrydexIdentifyResult | null>;
```

The old `fetchPriceHistory(cardId, game)` is **deleted** — there is no history
endpoint (`/prices/history/...` → 404 per contracts). History is now
store-and-accumulate (§3.6).

### 3.2 Zod schema mapping the REAL shape

```ts
const TrendDeltaSchema = z.object({ price_change: z.number().nullish(), percent_change: z.number().nullish() }).nullish();

const PriceEntrySchema = z.object({
  condition: z.string().nullish(),
  grade: z.string().nullish(),
  company: z.string().nullish(),
  type: z.string(),                               // "raw" = ungraded; else graded
  low: z.number().nullish(),
  market: z.number().nullish(),
  currency: z.string().default("USD"),
  trends: z.object({ days_1: TrendDeltaSchema, days_7: TrendDeltaSchema, days_14: TrendDeltaSchema }).nullish(),
});

const VariantSchema = z.object({ name: z.string().default("normal"), prices: z.array(PriceEntrySchema).default([]) });

const ScrydexCardSchema = z.object({
  id: z.string(),                                 // Scrydex-native id (e.g. "me55c-4"), NOT the TCGdex externalId
  name: z.string(),
  number: z.string().nullish(),                   // collector number — the match key
  printed_number: z.string().nullish(),
  expansion: z.object({ id: z.string().nullish(), name: z.string().nullish(),
    code: z.string().nullish() }).nullish(),      // set code/name — the match key
  variants: z.array(VariantSchema).default([]),
});
const ScrydexSingleCardResponseSchema = z.object({ data: ScrydexCardSchema });
// Search returns an ARRAY; include=prices makes each entry carry prices[] (contracts, VERIFIED).
const ScrydexSearchResponseSchema = z.object({
  data: z.array(ScrydexCardSchema).default([]),
  total_count: z.number().nullish(),
});
```

`?include=prices` is **required** on the request or `prices` is absent — the service
always appends it. Both the search endpoint and the single-card-by-id endpoint use the
legacy colon syntax where applicable.

### 3.2a Resolve Dojo card → Scrydex-native id (`resolveScrydexCard`) · resolves review-2 findings #1 & #4

**Why this exists.** `Card.externalId` is the TCGdex id for Pokémon (`base1-4`,
verified in `tcgdex.service.ts`) and the Bandai code for One Piece (`OP01-001`, verified
in `card.service.ts`). Scrydex uses a THIRD, native id namespace (contracts example
`me55c-4` with `expansion.id "me55c"`). Passing a TCGdex/Bandai id to
`GET /{slug}/v1/cards/{id}` 404s for essentially every card, which would silently reduce
the entire store-and-reuse series (FR-4), the dashboard real chart (AC-15), and PSA
graded routing (AC-16) to "no data" — masked by graceful `null` handling. So Scrydex
pulls MUST resolve the native id first. The §10 claim that "one externalId keys all
three providers" is **removed** (it is true only for the PokéWallet One Piece price
fill, where the join is on the Bandai code — see §4).

**Resolution procedure (`resolveScrydexCard`).**
1. `GET /{slug}/v1/cards?q=name:<card.name>&pageSize=25&include=prices` (legacy colon
   query — VERIFIED endpoint). Parse with `ScrydexSearchResponseSchema`.
2. **Match rule (explicit):** from `data[]`, pick the entry where the collector number
   matches AND the set matches:
   - number match: `normNumber(entry.number ?? entry.printed_number) === normNumber(card.number)`,
     where `normNumber` strips any `"/total"` suffix and leading zeros (Dojo `Card.number`
     can be `"4"` or `"4/102"`; Scrydex `number` is the bare `"4"`).
   - set match (tie-break when numbers collide across sets): prefer
     `entry.expansion.code === card.setCode` when `card.setCode` is known, else a
     case-insensitive `entry.expansion.name === card.setName`.
3. **Tie-break / ambiguity:** if exactly one entry matches number+set → use it. If
   several still match (different variants of the same printing) → take the first (they
   share one `prices[]` namespace per card anyway). If NONE matches number+set but
   exactly one entry matched name+number → use it (set metadata can differ in wording).
   If still ambiguous or zero matches → return `null` (never guess; the pull records a
   `failed` SyncLog and the chart stays "—").
4. Return `{ scrydexId: matched.id, card: matched }`. The caller uses `matched`'s
   `prices[]` DIRECTLY — **no second HTTP call** on first resolve (saves a credit).

**Caching the resolved id (additive schema change).** Add a nullable
`scrydexId String? @unique` column to `Card` (the migration is purely additive, so it
stays inside §0.1's non-destructive `db:push`; the §0.1 rollback note gains
`ALTER TABLE "card" DROP COLUMN "scrydexId"`). On a successful resolve,
`pullAndStoreScrydexPrice` writes `Card.scrydexId` so subsequent pulls skip the search
and go straight to `fetchScrydexCardById(scrydexId, game)` — one call, one credit, no
re-matching. A card with `scrydexId == null` that fails to resolve is simply retried on
the next pull (bounded by the freshness gate).

**One Piece scope (resolves review-2 finding #4).** The SAME resolver covers One Piece —
it searches `/onepiece/v1/cards?q=name:<name>` and matches on number+set, so One Piece
charts are NOT silently empty; they fill in whenever a card resolves. BUT the One Piece
slug `"onepiece"` is still UNVERIFIED (contracts confirm `pokemon` only), so the
implementation step MUST run the one spaced live probe in §4 before relying on it. If
the probe shows the slug/search shape differs for One Piece, the documented contingency
is: scope Scrydex history/charts to **Pokémon-only** for this task and record "One Piece
chart empty = expected until the slug is confirmed" in FR-4/§3.6 and the user checklist
— never leave it as an undocumented silent no-op.

### 3.3 Raw accessor (`pickRawPrice`, AC-5)

Iterate `variants[].prices[]`, pick the first entry with `type === "raw"` that has a
finite `market` or `low`. Return `{ market, low, currency, trends, variant,
condition }`. If no raw entry exists → `null` (clean, no throw).

### 3.4 Graded accessor (`pickGradedPrice`, AC-6)

Filter `prices[]` where `type !== "raw"` && `company?.toUpperCase() === (company ??
"PSA")` && `normalizeGrade(grade) === normalizeGrade(requested)`. `normalizeGrade`
reuses the "PSA 10"→10 parsing already in `graded-price.ts` (`parseGrade`). Return the
match's `market`/`low` or `null` when absent.

### 3.5 Vision endpoint discovery + contingency · FR-2d / OQ#4

**Discovery plan (implementation step, live, spaced).** The contracts flag that rapid
repeats to `api.scrydex.com` trip Cloudflare and HANG, so probe at most the 4
candidate paths **3–5s apart**, with a real small base64 image and the live key, in a
throwaway script (`scripts/probe-scrydex-vision.ts`, deleted after). **The candidate
path list is owned by the contracts file (§Vision) — do not restate a parallel list
here (resolves review-2 finding #6).** Probe the contracts' not-yet-tried candidates
(`/v1/vision`, `/pokemon/v1/vision/identify`, `/v1/image/match`, `/pokemon/v1/cards/vision`)
and SKIP the paths the contracts already record as 404'd
(`/v1/vision/identify`, `/pokemon/v1/vision/match`, `/pokemon/v1/vision`). If the
contracts' list changes, that file wins.

- If one resolves (2xx with a card id in the body), wire `identifyCard` to it, map to
  `ScrydexIdentifyResult { cardId, confidence, name, setCode }` (where `cardId` holds
  the external catalog id — see §3.1 finding-#1 decision), document the resolved path
  in a load-bearing comment, and parse the body with a Zod schema.
- **Contingency (chosen default):** if none resolves, `identifyCard` returns `null`
  and the existing graceful fallback in `recognize/route.ts` stands — a `null` match
  yields `ocrSource: "unavailable"`, which already signals the client to run on-device
  Tesseract and re-submit `text`. **This path is verified to exist** (read in
  `recognize/route.ts`). Document "Vision endpoint UNRESOLVED as of <date>; shipping
  with Tesseract fallback" in the service and the user checklist. Never fabricate a
  match. OQ#4 is resolved: shipping with the documented `null`→Tesseract fallback is
  acceptable for this task (the requirement explicitly sanctions it, AC-7).

### 3.6 Store-and-reuse persistence · FR-4 (the core of "charts show real data")

A single orchestration function owns the pull + persist + meter cycle. It lives in a
**new server module** `src/lib/services/scrydex-pricing.service.ts` (keeps the thin
`scrydex.service.ts` client free of Prisma — matches AGENTS.md §5.11 "services own
side effects, clients map shapes"):

```ts
export async function pullAndStoreScrydexPrice(
  // Widened to carry the fields resolveScrydexCard needs (name/number/set) + the cached
  // scrydexId. All are read in the single findUnique the sync/backfill already perform.
  card: { id: string; externalId: string; name: string; number: string; game: Game;
          scrydexId?: string | null; setName?: string | null; setCode?: string | null },
  opts?: { force?: boolean }
): Promise<{ pulled: boolean; credits: number }>;
```

Flow:

1. **Freshness gate (AC-11) — gated on `SyncLog`, resolves finding #9.** Unless
   `opts.force`, read the newest `SyncLog(job = "scrydex_history", cardId)` row by
   `ranAt`. If `ranAt` is within `SCRYDEX_STALE_MS` → **skip**: no HTTP call, no row,
   return `{ pulled: false, credits: 0 }`.

   **Why `SyncLog.ranAt`, not `CurrentPrice.updatedAt`:** a Scrydex card with no raw
   price entry (graded-only, or empty `prices[]`) writes NO `CurrentPrice` row
   (§3.6 step 3 only persists when `pickRawPrice` is non-null). If the gate read
   `CurrentPrice`, such a card would never show a "recent" row and would be re-pulled
   on **every** run — unbounded credit burn (exactly the review's finding #9). `SyncLog`
   is written on **every** attempt (ok AND failed, step 2/3/5), so it is the single
   authoritative throttle signal that covers priced, graded-only, failed, and empty
   cards alike. The query is
   `findFirst({ where: { job: "scrydex_history", cardId }, orderBy: { ranAt: "desc" } })`.

   **Index (resolves review-2 finding #7).** The existing schema has only
   `@@index([job, ranAt])` — there is **no** index on `SyncLog.cardId`, so the gate query
   would use `[job, ranAt]` for `job` + ordering but **scan** for the `cardId` filter.
   Add `@@index([job, cardId, ranAt])` to `SyncLog` — additive (no drop), so it stays
   inside §0.1's non-destructive `db:push`, and it backs the exact
   `where { job, cardId } orderBy { ranAt desc }` lookup. The earlier (wrong) claim that
   `cardId` was "indexed via the FK" is removed.

   ```ts
   // ponytail: global 24h staleness window — the smallest honest cadence that keeps
   // credit burn ~1/card/day. Ceiling: a card re-priced <24h ago won't refresh even if
   // the market moved intraday. Upgrade path: per-card volatility-driven windows.
   export const SCRYDEX_STALE_MS = 24 * 60 * 60 * 1000;
   ```

   Decision on OQ#3: the Scrydex **24h** window is a **separate** constant from
   `graded-price.ts`'s existing **7-day** `STALE_AFTER_MS`. They answer different
   questions (how often to re-pull live Scrydex pricing vs how old a *displayed*
   graded number may be before we flag it stale), so conflating them would couple two
   unrelated cadences. Keep both, each with its own `ponytail:`/comment rationale.

2. **Pull (via native-id resolution, finding #1).** If `card.scrydexId` is already
   cached, call `fetchScrydexCardById(card.scrydexId, game)` (one credit). Otherwise call
   `resolveScrydexCard({ name, number, setName, setCode, game })` (§3.2a) — one search
   call whose result already carries `prices[]`; on success, persist the resolved id to
   `Card.scrydexId` so future pulls take the by-id path. The orchestrator needs the card's
   `name`/`number`/`setName`, so its input widens to
   `{ id; externalId; name; number; game; scrydexId?; setName?; setCode? }` (all read in
   one `prisma.card.findUnique` the sync/backfill already does). On `null`/throw (no
   match, HTTP error, Zod fail) → write
   `SyncLog(job="scrydex_history", cardId, status="failed", error, credits:0)` and
   return `{ pulled:false, credits:0 }` (graceful — chart stays "—").

3. **Persist the fresh point (AC-9).** From `pickRawPrice`:
   - INSERT one `PricingHistory` row: `{ cardId, priceMarket, priceLow,
     source: "scrydex", currency, variant, condition, recordedAt: now }`. Use
     `createMany({ skipDuplicates: true })` so the composite unique
     `[cardId, recordedAt, source, currency, variant, condition]` makes re-runs
     idempotent.
   - UPSERT one `CurrentPrice` row keyed by `[cardId, source, currency, variant,
     condition]` with `source: DataSource.SCRYDEX`, `priceMarket`, `priceLow`.

   **Variant/condition normalization — SINGLE RULE (resolves finding #8).** `variant`
   and `condition` are taken **verbatim from the Scrydex price entry** (`entry.condition`,
   e.g. `"NM"`; the variant from `variant.name`, e.g. `"holofoil"`/`"normal"`). When
   Scrydex omits one, fall back to the schema defaults **`variant: "normal"`,
   `condition: "NM"`** (the exact `@default` values in `prisma/schema.prisma`). There is
   **no** `"Near Mint"`/`"Normal"` title-casing anywhere — those literals in the
   imported `scrydex-backfill.ts` are a bug (they would create duplicate rows that never
   dedupe against a `pullAndStoreScrydexPrice` write and never trip the freshness gate).
   `pickRawPrice` returns `{ variant, condition }` already normalized by this rule, and
   it is the ONLY place the rule lives, so every writer (sync, backfill, future callers)
   gets identical keys. This normalization is unit-tested in `scrydex-price.test.ts`.

4. **First-pull trend backfill (AC-10, OQ#2).** Only when this is the **first**
   `scrydex`/`scrydex-trend` `PricingHistory` row for `[cardId, variant, condition]`
   (checked with a `count` before step 3's insert), derive up to 3 prior absolute
   points from the trend deltas and INSERT them with `source: "scrydex-trend"`:
   - `−1d  price = market − trends.days_1.price_change`
   - `−7d  price = market − trends.days_7.price_change`
   - `−14d price = market − trends.days_14.price_change`

   Decision on OQ#2: reconstruction is **absolute delta subtraction**
   (`market − price_change`), NOT percent-based — `price_change` is already an
   absolute USD delta in the verified payload, so subtracting it yields the prior
   absolute price directly. `recordedAt` for each is `now − {1,7,14} days`. A delta
   that is `null`/missing simply skips that point (never fabricate). These rows carry
   `source: "scrydex-trend"` so they are visually/queryably distinguishable from fresh
   `scrydex` snapshots.

   Decision on OQ#5: trend points go to **`PricingHistory` ONLY**. `CurrentPrice.source`
   is the `DataSource` enum which has no `scrydex-trend` member; the free-text
   `PricingHistory.source` is where `"scrydex-trend"` belongs. `CurrentPrice` always
   records `DataSource.SCRYDEX` for the fresh point. The design states this explicitly
   so the implementer never tries to write a `scrydex-trend` `CurrentPrice`.

5. **Credit metering (AC-12).** Write `SyncLog(job="scrydex_history", cardId,
   status="ok", credits: SCRYDEX_CREDITS_PER_CALL)` on each successful
   Scrydex fetch (`resolveScrydexCard` search OR `fetchScrydexCardById` — one HTTP call
   either way); backfill points add no extra credits (derived from the same
   single response). **The per-call credit cost is PROVISIONAL (resolves finding #13):**
   the "1 credit/call" figure is NOT in the verified contracts — it is an assumption.
   Model it as a named constant `const SCRYDEX_CREDITS_PER_CALL = 1; // ponytail:
   provisional — the FR-7 pilot MEASURES real cost; update this constant from the
   pilot's reported burn before any bulk backfill.` The FR-7 pilot (§8) exists
   precisely to measure the real credit cost from the provider's actual accounting
   (e.g. a response header or dashboard delta); its summary records the measured
   figure and the implementer updates the constant if it differs from 1.

**Invariant ownership.** The freshness gate and the "trend backfill only on first
pull" invariant are owned by `scrydex-pricing.service.ts` (the only writer), not the
routes — centralising them is why the backfill script and the sync engine can both
call `pullAndStoreScrydexPrice` without duplicating the guard (bug-fix-the-shared-function
discipline).

### 3.7 Error handling (Scrydex)

| Operation | Failure | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `resolveScrydexCard`/`fetchScrydexCardById` | missing `X-Team-ID` | fatal (config) | throw at header build | — (fail fast; proven to 401 live) |
| `resolveScrydexCard`/`fetchScrydexCardById` | HTTP !ok / 404 / network | yes | `null` | `console.warn [scrydex]` |
| `resolveScrydexCard`/`fetchScrydexCardById` | Zod parse fail / no name+number+set match | yes | `null` | `console.warn` + issue summary |
| `pullAndStoreScrydexPrice` | pull returns null | yes | `{pulled:false}` + failed SyncLog | SyncLog row |
| `identifyCard` | any | yes | `null` → Tesseract fallback | `console.warn` |

---

## 4. Sync engine price-fallback wiring · FR-3

`sync-cards.service.ts` currently (incorrectly) sources the One Piece **catalog** from
PokéWallet (`fetchPWOnePieceSets`/`fetchPWOnePieceCards`). That violates the
requirement that One Piece catalog stays on apitcg. Rewrite the One Piece adapter
section to:

**Catalog upsert MUST stamp `Card.game` + `Card.source` (resolves finding #4 — HIGH).**
The imported `upsertCard` sets neither, so every card defaults to
`game = POKEMON`/`source = TCGDEX` (schema defaults). That silently mis-slugs every
One Piece card's Scrydex pull (`gameSlug(POKEMON)` → `/pokemon/v1/...` for a One Piece
card). **Fix:** thread the `Game` through the sync. `syncOneSet` already knows the
`game: Game` ("pokemon"|"onepiece") string; map it to the Prisma `Game` enum and pass
both `game` + `source` into `upsertCard`, which writes them in BOTH the `create` and
`update` branches:
- Pokémon path (TCGdex): `game = Game.POKEMON`, `source = DataSource.TCGDEX`.
- One Piece path (apitcg): `game = Game.ONE_PIECE`, `source = DataSource.TCGDEX`
  (apitcg is the catalog; there is no `APITCG` enum member — `TCGDEX` is the closest
  catalog marker, OR add an `APITCG` member to `DataSource` if the implementer prefers
  honesty. **Decision: do NOT expand the enum** — `Card.source` records which *price*
  pipeline owns the card and apitcg One Piece prices flow through the PokéWallet/`.io`
  surface; set `source = DataSource.TCGDEX` for both catalog imports to mean "catalog
  from the primary catalog provider," and let `CurrentPrice.source` carry the true
  per-price provenance. This keeps the migration purely additive.)

The `gameSlug` helper in `scrydex.service.ts` (§3.1) maps the Prisma enum to the
Scrydex path slug **literally**: `Game.POKEMON → "pokemon"`, `Game.ONE_PIECE →
"onepiece"`. **The One Piece slug `"onepiece"` is UNVERIFIED** (contracts confirm
`pokemon` only). The implementation step MUST probe one spaced live
`GET /onepiece/v1/cards?q=name:luffy&pageSize=1&include=prices` (3–5s pacing per the
Cloudflare note) and adjust the slug if it 404s before relying on it for One Piece
Scrydex pulls. Until confirmed, One Piece Scrydex pulls are treated as best-effort
(a 404 is a graceful `null` pull, logged to `SyncLog`).

- **Pokémon catalog** — unchanged source: `tcgdex.service.ts` `fetchSets`/`fetchCardsBySet`
  (metadata + images, no prices). Primary, as today; now stamps `game = POKEMON`,
  `source = TCGDEX` on upsert (above).
- **Pokémon price gap (exact call-site edit — resolves review-2 finding #3).** The
  current `listPokemonCardsInSet` loop calls `fetchPokemonCardPrice(c.id)` (verified: it
  passes the TCGdex **id** `c.id`). Because the rewritten accessor is name-based
  (`GET /search?q=<name>`), this call MUST change to **`fetchPokemonCardPrice(c.name)`** —
  passing `c.id` would query `?q=base1-4` and always return no price (a silent gap). The
  surrounding `isActive` guard and the `await sleep(REQUEST_DELAY_MS)` throttle stay
  exactly as they are (NFR-8). **Known imprecision (acknowledged, acceptable):** a
  name-based lookup is ambiguous — many Pokémon share a name across sets, so the matched
  `/search` price may be a different printing. This is tolerable *only as a last-resort
  gap fill*: it runs only when TCGdex has no price at all, so any plausible market number
  is strictly better than rendering "—", and the authoritative per-printing price is
  refreshed later by the Scrydex pull (which resolves by name+number+set, §3.2a). No
  set/number disambiguation is added here to keep the diff minimal; the Scrydex path is
  where precision lives.
- **One Piece catalog** — switch to apitcg. The sync's One Piece set/card listing must
  stop importing from PokéWallet. `card.service.ts`'s `fetchApiTcgOnePiece` is a
  *search*-shaped function (`?name=<query>`), so the set-walk needs the apitcg sets +
  set-filtered products endpoints. **Decision (resolves finding #7 — specify shape, Zod,
  mapping, empty-handling): add two thin fetchers in `sync-cards.service.ts`** reusing
  the `x-api-key: APITCG_API_KEY` header already proven in `card.service.ts`
  (reconnecting a trusted source, not a new integration):

  **`listOnePieceSets(): Promise<SyncSetInput[]>`** —
  `GET https://api.apitcg.com/api/one-piece/sets`, header `x-api-key: APITCG_API_KEY`.
  Response shape (per the existing load-bearing comment in `sync-cards.service.ts`):
  `{ success?: boolean, data: [{ _id: string, name: string, code?: string,
  release_date?: string }] }`. Zod:
  ```ts
  const ApiTcgSetSchema = z.object({ _id: z.string(), name: z.string(),
    code: z.string().nullish(), release_date: z.string().nullish() });
  const ApiTcgSetsResponseSchema = z.object({ success: z.boolean().optional(),
    data: z.array(ApiTcgSetSchema) });
  ```
  Map `sourceSetId = _id` (the slug like `"one-piece-romance-dawn"` that the
  `/products` `set=` filter expects — per the existing comment), `name`, `series =
  "One Piece Card Game"`, `releaseDate = release_date ? new Date(...) : null`. A parse
  failure or empty `data` → **`throw new NoResultsError(...)`** (NFR-1), caught by
  `safelyListSets` which already logs and returns `[]` so a One Piece outage never
  starves the Pokémon sync.

  **`listOnePieceCardsInSet(sourceSetId): Promise<SyncCardInput[]>`** —
  `GET https://api.apitcg.com/api/products?tcg=one-piece&set={sourceSetId}&limit=500`,
  same header. **MANDATE (resolves review-2 finding #2): export the existing
  `ApiTcgProduct` interface from `card.service.ts` and reuse it** — do NOT re-declare a
  divergent trimmed shape, so the two consumers cannot drift. The REAL shape (verified in
  `card.service.ts`, consumed as `p.images?.[0]`) is: `images` is an **ARRAY**
  `Array<{ small?, medium?, large? }>`, NOT an object with a `large` field. The matching
  Zod (identical to how `fetchApiTcgOnePiece` reads it):
  ```ts
  const ApiTcgProductSchema = z.object({
    code: z.string().nullish(), _id: z.number().nullish(), name: z.string(),
    images: z.array(z.object({                               // ARRAY, finding #2
      small: z.string().nullish(), medium: z.string().nullish(), large: z.string().nullish(),
    })).nullish(),
    attributes: z.object({ Rarity: z.string().nullish(), Number: z.string().nullish(),
      Color: z.string().nullish(), CardType: z.string().nullish(),
      Subtypes: z.string().nullish() }).nullish(),
    markets: z.object({ tcgplayer: z.object({ prices: z.object({
      market: z.number().nullish() }).nullish() }).nullish() }).nullish(),
  });
  const ApiTcgProductsResponseSchema = z.object({ success: z.boolean().optional(),
    data: z.array(ApiTcgProductSchema).default([]) });
  ```
  Per-card `SyncCardInput` mapping (identical id + image convention to `card.service.ts`
  `fetchApiTcgOnePiece`, findings #2 & #10): **`externalId = product.code`** (the Bandai
  card code like `"OP01-001"`; fall back to `String(_id)` only if `code` is missing) —
  this is the **same string PokéWallet returns as `card_number`**, the join key the price
  fill relies on (asserted explicitly below). `name = product.name`;
  `number = attributes?.Number ?? code`; `rarity = attributes?.Rarity ?? null`;
  `types = parseOnePieceAttrs(attributes)` (reuse the existing helper);
  **`const img = product.images?.[0]; imageUrl = img?.large ?? img?.medium ?? img?.small ?? null;`**
  (identical to `fetchApiTcgOnePiece`; same-origin proxy rewrite happens later via
  `cleanImageOnImport`); `marketPrice = markets?.tcgplayer?.prices?.market ?? null`
  (apitcg's own tcgplayer price — the FIRST price attempt before the BerryWallet gap
  fill). Drop any product with no `code`/`name`. Empty valid set after filtering →
  **`throw new NoResultsError(...)`** (NFR-1), consistent with the Pokémon path.

- **One Piece price gap (join key explicit — resolves finding #10).** For a set being
  synced, after building the apitcg card list, call `fetchOnePieceSetPrices(setCode)`
  once per set (one request per set, batched — stays under the free tier). The returned
  `Map<string, OnePiecePrice>` is keyed by PokéWallet `card_number`. **ASSERTION made
  explicit:** `Card.externalId` written by the catalog upsert IS the Bandai card code
  (`product.code`, e.g. `"OP01-001"`), which is byte-identical to PokéWallet's
  `card_number` for the same card (both are the official Bandai code — verified in
  contracts: PokéWallet `card_number: "OP01-001"`). Therefore the price fill is a
  direct `priceMap.get(card.externalId)` with NO normalization needed. The `setCode`
  passed to `fetchOnePieceSetPrices` is the Bandai set code (`"OP01"`), which the
  apitcg set carries as its `code` field (distinct from the `_id` slug used for the
  products filter) — so `listOnePieceSets` must also surface `code` to the sync for
  this call, OR derive it from the first card's `externalId` prefix (`"OP01-001"` →
  `"OP01"`). **Decision:** derive the Bandai set code from the first card's externalId
  prefix (`externalId.split("-")[0]`) — avoids depending on apitcg's optional `code`
  field and keeps the two providers joined on the one id both agree on (the card code).
  Only fill `marketPrice` from the PokéWallet map when the apitcg `markets.tcgplayer`
  price was null (gap fill, not override). BerryWallet (= PokéWallet `.io` One Piece
  surface) is thereby wired into the One Piece price path **for price only**, never
  catalog.

**Preserved behaviour (AC-8):** smart-sync active-only repricing, `STALE_AFTER_DAYS`
window, `interleaveByGame`, `RUN_BUDGET_MS` wall-clock budget, and fetch-before-upsert
(so a failed fetch retries next run) are all untouched. The load-bearing WHY comments
(id prefix convention, fetch-before-upsert ordering, concurrency rationale) stay
verbatim (NFR-9).

The sync calls `pullAndStoreScrydexPrice` for active cards (both games) after the
catalog upsert to grow the real history series on the daily cadence — gated by the
freshness window, the credit budget, and the `RUN_BUDGET_MS` deadline check, and
additive. Because that pull now goes through `resolveScrydexCard` (§3.2a), which searches
by name+number+set rather than assuming the externalId is a Scrydex id, **both Pokémon
AND One Piece cards resolve and accumulate history** (resolves review-2 finding #4) — One
Piece is NOT a silent no-op. The One Piece slug caveat is handled by the §4 live probe
below and the §3.2a Pokémon-only contingency: if the probe shows the One Piece slug/search
differs, Scrydex charts are scoped Pokémon-only and that is documented in the user
checklist as expected, not a bug. A `SyncLog job="scrydex_history"` row is written per
attempt either way.

---

## 5. Portfolio value snapshot on add · FR-5 (OQ#1)

**Decision: NO new table. Reuse `PricingHistory` + read-time aggregation.** This is
the smallest correct choice and it is already half-built:

- The uncommitted `GET /api/users/me/collection/history` route **already** aggregates
  portfolio value as `Σ (PricingHistory.priceMarket × quantity)` per day across the
  user's active cards (verified by reading it). So the dashboard graph reads real data
  the moment any card in the collection has `PricingHistory` rows.
- Therefore "capture a portfolio value data point on add" is satisfied by ensuring the
  **added card has a priced `PricingHistory` point at add-time**, which the aggregation
  then rolls into the portfolio total — rather than storing a redundant
  whole-portfolio value that would duplicate state and drift from the per-card truth.

**Concrete change to `POST /api/users/me/collection`:** after the existing card
upsert + `UserCollection` create/update (which must stay byte-for-byte compatible with
`assignBulkAddOrder`'s strictly-decreasing `addedAt`, the graded-vs-raw dedupe, and
ownership scoping — AC-13, F-15), for each successfully-added card write ONE
`PricingHistory` row capturing the card's market price **at add-time ONLY when a
non-null price is known** (`const addPrice = item.marketPrice ?? card.marketPrice;
if (addPrice != null && addPrice > 0) { … }`), with `source: "add-snapshot"`,
`priceMarket: addPrice`, `variant: "normal"`, `condition: "NM"` (schema defaults, so
the composite unique key is deterministic), `recordedAt: now`, via
`createMany({ skipDuplicates: true })`. This is best-effort: wrapped in try/catch, a
snapshot failure never fails the add (NFR-4). **A null/zero price writes NO row**
(NFR-2 — never a fabricated $0 point; this is the same invariant the review flags in
finding #3): the graph simply has no point for that card yet and fills in on the next
Scrydex pull.

**Interaction with finding #5 (dashboard ≥2-point threshold).** The add-snapshot
writes exactly ONE dated point for a priced card. On its own that is below the imported
`realHistory.length > 1` gate, so the real line would never show after a single add.
This is resolved in §7.1 by lowering the `DashboardClient` threshold to `>= 1` so one
real add-snapshot point renders a real (short/flat) line. Thus AC-13's "readable by
the portfolio graph" is satisfied end-to-end by: add-snapshot writes a real point →
collection/history aggregates it (now null-safe per §7.1) → DashboardClient renders it
at `>= 1`.

Why `source: "add-snapshot"` and not reuse `"scrydex"`: it keeps add-time points
distinguishable from pulled market snapshots in the history table, and the history
aggregation query already sums all sources per card/day (it does not filter by
source), so no query change is needed. This writes to `PricingHistory` only; no
`CurrentPrice`/enum concern.

**Why not a dedicated snapshot table.** A `PortfolioSnapshot(userId, collectionId,
value, at)` table would capture total value at add-time directly, but: (a) it
duplicates data derivable from per-card `PricingHistory × quantity`; (b) it would need
backfilling for existing collections to show any history; (c) the read path already
exists for the per-card aggregation. The per-card approach also means the graph
updates when **any** card's price refreshes, not only on adds. The tradeoff — the
graph reflects *current holdings priced over time* rather than a frozen *historical
portfolio value including since-sold cards* — is acceptable for this app (the history
route already filters `isSold: false`). This is noted as a known modelling ceiling.

**No schema change for FR-5** → no migration needed beyond §0.1's enriched schema.

---

## 6. PSA graded-price routing · FR-6

Route graded pricing through Scrydex first, with the existing curated table + PSA cert
fallback — **reusing `resolveGradedPrice`'s live-source-with-fallback contract**, not
reinventing it (AC-16). `resolveGradedPrice` already takes an optional
`priceSource: () => number | null | undefined` and sets `isFallback` accordingly.

**Call-site discovery (resolves finding #6 — HIGH).** A grep for
`resolveGradedPrice|fetchPSAGradedPrice|gradedPrice(` across `src/` finds that these
functions have **NO caller anywhere** — they are defined but dead. The only place a
graded price is actually surfaced today is the card-detail page
(`src/app/(dashboard)/search/[id]/page.tsx`), which computes the PSA 10 row **on the
client** with a hard-coded heuristic (`const psa10Multiplier = 2 + 50/(rawPrice+10)`,
flagged `TODO Week 3: replace with real graded pricing data`). `page.tsx` is a client
component, so it **cannot** call `fetchScrydexCard`/`resolveGradedPrice` directly
(NFR-5: Scrydex key is server-only). Therefore a **new server endpoint is required** —
there is no existing server caller to amend.

**Decision: add `GET /api/cards/[id]/graded?grade=<g>` (new, server-side).** `[id]` is
the external card id (same convention as the sibling `prices`/`history` routes); the
route resolves the card, fetches Scrydex, runs `resolveGradedPrice`, and returns the
resolved graded value + flags. `game` is read from the resolved `Card.game` (DB), not
the query string — the server owns the id→game mapping (NFR-3). `grade` comes from the
query string (`?grade=10`, default "10"); `rawMarketPrice` is the card's stored
`marketPrice`.

```ts
// src/app/api/cards/[id]/graded/route.ts  (NEW)
export async function GET(req, { params }) {
  const { id: externalId } = await params;
  const grade = new URL(req.url).searchParams.get("grade") ?? "10";
  // NFR-4: public card route — 200 + null payload on unknown/err, never 4xx/5xx.
  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      select: { id: true, game: true, name: true, number: true, scrydexId: true,
                marketPrice: true, lastPricedAt: true, set: { select: { name: true } } },
    });
    if (!card || card.marketPrice == null) {
      return NextResponse.json({ price: null, isFallback: true, isStale: true },
        { headers: { "Cache-Control": "no-store" } });
    }
    // Resolve the Scrydex-native id (uses cached Card.scrydexId when present), §3.2a.
    const resolvedScrydex = card.scrydexId
      ? { card: await fetchScrydexCardById(card.scrydexId, card.game) }
      : await resolveScrydexCard({ name: card.name, number: card.number,
          setName: card.set?.name ?? undefined, game: card.game });
    const scrydexCard = resolvedScrydex?.card ?? null;   // server-only, may be null
    const resolved = resolveGradedPrice({
      cardName: card.name, setName: card.set?.name ?? "", grade,
      rawMarketPrice: card.marketPrice, lastPricedAt: card.lastPricedAt,
      priceSource: () => (scrydexCard ? pickGradedPrice(scrydexCard, grade, "PSA")?.market ?? null : null),
    });
    return NextResponse.json(resolved, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/graded] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ price: null, isFallback: true, isStale: true },
      { headers: { "Cache-Control": "no-store" } });
  }
}
```

Resolution order (owned by `resolveGradedPrice`): Scrydex PSA entry → curated
`graded-price.ts` table → coarse multiplier; `isFallback`/`isStale` surface the
distinction. The offline path (`psa-price.service.ts` cert verify + curated table) is
unchanged and remains the degradation target when Scrydex has no graded entry or the
call fails. No new graded-price *module*; the only new code is this thin route +
passing a Scrydex-backed `priceSource`.

**Client wiring (minimal).** `page.tsx` fetches `GET /api/cards/[id]/graded?grade=10`
(TanStack Query key `["graded", externalId, grade]`) and uses the returned `price` for
the PSA 10 row when present, keeping the existing heuristic multiplier as the
graceful fallback for when `price` is `null` (so the UI never regresses to blank). The
`isFallback` flag lets the row distinguish a real Scrydex quote from the heuristic —
surfaced the same way `resolveGradedPrice` consumers are expected to (a subtle "est."
marker is out of scope; the flag is wired but display polish is deferred). This keeps
the change to one new route + a small query hook in the existing page.

---

## 7. UI wiring · FR-6

These are mostly already present in the uncommitted mainline files (verified) and need
only to land in the worktree:

- **Card-detail chart** (`search/[id]/page.tsx`): already queries
  `GET /api/cards/[id]/history` and drives the Raw line from real `PricingHistory`
  points when `>= 2` exist, keeping the mock `CHARTS` shape only as the graceful
  short-/empty-line fallback (AC-14). No further change beyond import.
- **Scanner** (`recognize/route.ts`): already calls `identifyCard` (reads
  `scrydexResult.cardId` — matches §3.1) and falls back to `ocrSource: "unavailable"`
  → Tesseract (AC-17). Land via import; behaviour depends on §3.5 discovery outcome.

### 7.1 Route edits required to satisfy NFR-2/NFR-4 (resolves findings #2, #3, #5)

These three routes/one component are **modified minimally** (NOT "import unchanged" —
the review correctly flags that the imported versions violate NFR-2/NFR-4):

- **`GET /api/cards/[id]/prices` (finding #2 — NFR-4 violation).** The imported version
  returns HTTP **404** for an unknown card and HTTP **500** in the catch branch. That
  breaks the "public card routes return 200 with fallback payloads, never 5xx" rule
  (NFR-4, AGENTS.md §5.7). **Fix:** both branches return `{ prices: [] }` with HTTP
  **200** and `Cache-Control: no-store`. Add a one-line comment: `// NFR-4: public
  card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").`

  ```ts
  if (!card) {
    return NextResponse.json({ prices: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  // …catch…
  return NextResponse.json({ prices: [] }, { headers: { "Cache-Control": "no-store" } });
  ```

- **`GET /api/cards/[id]/history` (finding #3 — NFR-2 violation).** The imported
  version maps `price: r.priceMarket ?? 0`, which **fabricates** a $0 data point for
  any row whose market price is unknown — a fake chart point, violating NFR-2 ("missing
  value → null → —, never invented"). **Fix:** filter out rows where `priceMarket ==
  null` BEFORE mapping, so only real priced points reach the chart:

  ```ts
  const points = rows
    .filter((r) => r.priceMarket != null)        // NFR-2: never emit a fabricated 0 point
    .map((r) => ({ date: r.recordedAt.toISOString().slice(0, 10), price: r.priceMarket as number }));
  ```
  The route already returns `{ points: [] }` + 200 on unknown-card/error, so NFR-4 is
  satisfied; only the null→0 fabrication changes.

- **`GET /api/users/me/collection/history` (finding #3 — NFR-2 violation + finding #5).**
  Two edits:
  1. **NFR-2:** the portfolio aggregation substitutes `0` for a null price in two
     places (`pricesByDateAndCard…set(cardId, row.priceMarket ?? 0)` and
     `lastSeenPrices.get(cardId) || 0`). Fix: when building `pricesByDateAndCard`, SKIP
     rows where `priceMarket == null` (never seed a fabricated 0); in the daily loop,
     only add a card's contribution to `totalValue` when it has a real last-seen price
     (`const price = lastSeenPrices.get(cardId); if (price == null) continue;`). A
     card with no priced history simply doesn't contribute to the portfolio total yet
     — honest, not a $0 drag. Also change the catch branch from HTTP 500 to
     `{ histories: {} }` + 200? **No** — this is an AUTHED route, not a public card
     route, so NFR-4 does not require 200; the existing 500 on a genuine server error
     is acceptable (AGENTS.md §5.7 scopes graceful-200 to public card/eBay routes).
     Leave the 500 catch as-is; only remove the null→0 fabrication.
  2. **Finding #5 (dashboard needs ≥2 points):** see §5 — the add-snapshot alone writes
     one dated point, but `DashboardClient` only renders a real line when
     `realHistory.length > 1`. Resolution chosen below.

- **`DashboardClient.tsx` (finding #5).** **Decision (option a from the review): lower
  the real-line threshold from `> 1` to `>= 1` and render the real series whenever it
  exists**, so a single real add-snapshot point produces a visible (flat/short) real
  line instead of silently falling back to the synthetic `generateMockChartData`
  shape. A one-point series renders as a single marker / short flat line, which is the
  honest representation of "we have one real datapoint so far; it grows on the next
  pull." Concretely:

  ```ts
  const data = realHistory && realHistory.length >= 1     // was > 1 — finding #5
    ? realHistory
    : (opt.marketValue > 0 ? generateMockChartData(opt.marketValue, activeRange, idx * 37)
                           : [{ value: 0 }, { value: 0 }]);
  ```
  This moves `DashboardClient.tsx` to "modified minimally." The e2e assertion in §9.3
  is correspondingly: after an add, the portfolio chart shows a **real** series (≥1
  real point), distinguishable from the mock shape. Why option (a) over (b)/(c): it is
  the smallest change (one operator), needs no seeding of synthetic second points
  (which would risk fabrication), and matches the product intent ("charts show real
  data once we have any"). The trade-off — a single point renders as a short/flat line
  rather than a trend — is acceptable and self-corrects as more pulls accumulate.

The only other UI-adjacent nicety: trim the stale "falls back to the mock chart
generator" wording in the `cards/[id]/history` doc-comment to reflect that it now
returns only real points (the detail page still has its own mock fallback when
`points` is empty). Minimal churn.

---

## 8. Backfill pilot · FR-7

Rewrite `scripts/scrydex-backfill.ts` to call `pullAndStoreScrydexPrice` (not the
deleted `fetchPriceHistory`, and **not** its own inline `createMany`). **The imported
script writes `condition: "Near Mint"`, `variant: "Normal"` literals directly
(finding #8); those are DELETED** — the rewritten script does ZERO direct Prisma
writes and defers entirely to `pullAndStoreScrydexPrice`, so the variant/condition
normalization (§3.6 step 3: verbatim-from-Scrydex with `"normal"`/`"NM"` defaults) and
the freshness/backfill/metering invariants are byte-identical to the sync path. This is
the whole point of centralising the writer: one normalization rule, one freshness gate,
one credit meter — the backfill cannot drift from the sync. Concretely:

- Select exactly 10 cards present in some `UserCollection` (`userCollections: { some: {} }`,
  `take: 10`), selecting `{ id, externalId, game }`.
- For each, `await pullAndStoreScrydexPrice(card)` — which respects the freshness gate
  (idempotent re-runs skip, AC-18, now gated on `SyncLog.ranAt` per finding #9) and
  writes the per-card `SyncLog`.
- Space calls ≥ 3s apart (Cloudflare note in contracts) via `sleep(3000)`.
- Sum `credits` from the returned values and print a summary (total credits, per-card
  ok/skip/fail). This is the cost measurement before any bulk backfill (bulk is out of
  scope). **Record the MEASURED credit figure** (finding #13) and update
  `SCRYDEX_CREDITS_PER_CALL` if the provider's real accounting differs from the
  provisional `1`.

---

## 9. Test plan · FR-8 (F-number TDD style)

**Separation of live vs mocked:** All committed Vitest/Playwright tests use **mocked
`fetch`/Prisma** — no live network, no credits (matches the existing `psa-price.test.ts`
pattern). The **only** live verification is the one-time Scrydex Vision endpoint probe
(§3.5) and a single patient manual sanity call, done in throwaway scripts and recorded
in the design/checklist — never in the test suite (Cloudflare + credit cost + CI
determinism forbid live calls in `verify`).

### 9.1 Unit (Vitest, mocked `fetch`) — `tests/unit/`

- **`pokewallet-price.test.ts` (FR-1, AC-2/3):** `pickOnePiecePrice` returns numeric
  `market` for a normal card and `null` (no throw) for a CM-only `tcgplayer: null`
  card; `fetchOnePieceSetPrices` maps a mocked `/op/sets/OP01` body to a `Map` keyed by
  `card_number`; `fetchPokemonCardPrice` reads a price from a mocked `/search` body and
  returns `null` on empty results.
- **`scrydex-price.test.ts` (FR-2, AC-5/6):** `pickRawPrice` returns `market`/`low`
  from the `type:"raw"` entry and `null` when absent; `pickGradedPrice` returns the
  `type!="raw"`,`company:"PSA"`,grade-matching entry and `null` otherwise, against the
  real `variants[].prices[]` fixture shape from the contracts. Also asserts the
  **variant/condition normalization rule (finding #8):** `pickRawPrice` returns
  `condition`/`variant` verbatim from the Scrydex entry, and falls back to exactly
  `"NM"`/`"normal"` (schema defaults, NOT `"Near Mint"`/`"Normal"`) when Scrydex omits
  them. Header tests: building headers without `SCRYDEX_TEAM_ID` throws (documents the
  live-401 behaviour, AC-4); `gameSlug(Game.POKEMON) === "pokemon"` and
  `gameSlug(Game.ONE_PIECE) === "onepiece"`.
  **`resolveScrydexCard` matching (review-2 finding #1):** against a mocked search body
  with multiple entries, it picks the entry whose `number` matches `card.number`
  (normalizing `"4/102"`→`"4"` and stripping leading zeros) AND whose `expansion.code`/
  `expansion.name` matches the card's set; returns `null` on no number+set match and does
  the name+number single-match fallback. Pure match logic over a mocked `fetch` response —
  no live call.
- **`scrydex-trend-backfill.test.ts` (FR-4, AC-10, OQ#2):** given a raw entry with
  `trends.days_{1,7,14}.price_change`, the backfill helper produces exactly the −1/−7/−14d
  absolute points via `market − price_change`, skips `null` deltas, and labels them
  `scrydex-trend`. Pure helper, no Prisma.

### 9.2 Integration (Vitest, mocked Prisma + `fetch`) — `tests/integration/`

- **`scrydex-pricing.test.ts` (FR-4, AC-9/11/12):** `pullAndStoreScrydexPrice` writes
  one `scrydex` `PricingHistory` + upserts one `CurrentPrice` on a fresh pull; skips
  entirely (no fetch, no row) when a recent `SyncLog(job="scrydex_history", cardId)` row
  within `SCRYDEX_STALE_MS` exists (fresh), and proceeds when the newest such `SyncLog` is
  older or absent (matches the §3.6 step-1 SyncLog-based gate, finding #5 of review 1 /
  this test wording per review-2 finding #5); writes a
  `SyncLog{job:"scrydex_history",status:"ok",credits:1}` on success and
  `{status:"failed",credits:0}` when the pull returns null. Prisma mocked.
- **`portfolio-snapshot.test.ts` (FR-5, AC-13):** POST add writes an `add-snapshot`
  `PricingHistory` point for a priced card, skips it for an unpriced one, and the add
  still succeeds either way; assert `assignBulkAddOrder` ordering is untouched (extend
  or sit alongside the existing `bulk-add-order.test.ts` — change that F-15 test first
  if behaviour shifts; it must still pass).
- **`graded-routing.test.ts` (FR-6, AC-16):** when the Scrydex `priceSource` yields a
  PSA `market`, `resolveGradedPrice` returns it with `isFallback:false`; when it yields
  `null`, the curated/multiplier value returns with `isFallback:true`. Reuses the
  existing golden fixtures for the fallback numbers. Also covers the new
  `GET /api/cards/[id]/graded` route (mocked Prisma + `resolveScrydexCard`/
  `fetchScrydexCardById`): a priced card with a Scrydex PSA entry returns
  `{ price, isFallback:false }`; an unknown card or an unpriced card returns
  `{ price:null }` + HTTP 200 (NFR-4, review-1 finding #6).
- **`history-null-safe.test.ts` (findings #2/#3 — NFR-2/NFR-4):** `GET /api/cards/[id]/history`
  drops rows with `priceMarket == null` (no fabricated 0 point) and returns `{ points: [] }`
  + 200 for an unknown card; `GET /api/cards/[id]/prices` returns `{ prices: [] }` + 200
  (not 404/500) for unknown-card and error branches; `GET /api/users/me/collection/history`
  skips null-priced rows so a card with no priced history contributes 0 to the total
  only by absence (not a fabricated 0). Mocked Prisma. These pin the §7.1 route edits so
  a future "import unchanged" regression is caught.
- Existing `psa-price.test.ts`, `graded-pricing.golden.test.ts`, `golden-prices.test.ts`
  must stay green (no contract change to the offline fallback).

### 9.3 e2e (Playwright, standalone build on :3001) — `e2e/`

Uses existing projects (`setup`→storageState, `authed`, `camera`). Requires the
enriched schema applied to the DB (§0.1) and ideally a seed of ≥1 card with real
`PricingHistory` points so a real line renders.

- **`portfolio-real-chart.spec.ts` (FR-5/6, authed):** search → add a card → dashboard
  portfolio chart renders a real series when history exists, else the empty state (no
  crash). Assert the chart element and a non-mock data signal where feasible.
- **`card-detail-chart.spec.ts` (authed):** open a card detail → price-history chart
  renders (real points if present, graceful short/empty line otherwise); tooltip shows
  a real date+price only when driven by real points (reuses existing
  `chart-interactivity.spec.ts` conventions).
- **Scanner** — extend `scanner.camera.spec.ts`: with Scrydex Vision mocked at the
  network layer (or unresolved), the fake-media-device scan falls back to Tesseract via
  `ocrSource: "unavailable"` and still produces candidates (the existing camera-project
  path).
- **Graded add** — extend `graded-add-flow.spec.ts`: add a PSA 10 copy and assert a
  graded price shows (Scrydex-backed when available, fallback otherwise; distinction
  via the existing flags).

### 9.4 Gate

Run `npm run verify` in the worktree (`lint → test:unit → test:integration →
test:chart-accuracy → e2e`). The chart-accuracy gate validates against the mocked
Collectr reference (AGENTS.md §6 intentional stub) — unchanged. Report exact
pass/fail counts for each stage (AC-20). Fix all failures before claiming done.

---

## 10. Edge cases

- **CM-only One Piece set** (`tcgplayer: null`, negative `group_id`): price falls to
  `cardmarket` then `null`; never throws (§2.3, AC-2).
- **Scrydex card with no raw entry** (graded-only or empty `prices`): `pickRawPrice`
  → `null`; no `PricingHistory`/`CurrentPrice` written; `SyncLog` STILL records the
  attempt. Because the freshness gate reads `SyncLog.ranAt` (not `CurrentPrice`), this
  card is correctly throttled for 24h instead of being re-pulled every run (finding #9).
  Chart stays empty ("—").
- **Null-priced history/portfolio rows:** `GET /api/cards/[id]/history` and the
  portfolio aggregation SKIP rows with `priceMarket == null` rather than coercing to 0,
  so no fabricated $0 chart point or portfolio drag appears (NFR-2, findings #2/#3).
- **First pull with missing trend deltas:** backfill skips the missing points (writes
  0–3 points), never fabricates.
- **Re-pull within 24h:** freshness gate short-circuits — no HTTP, no credit, no row.
- **Add a card with no known price:** no `add-snapshot` point; graph fills on next pull.
- **Three id namespaces (NFR-3, corrected per review-2 findings #1/#4):** `Card.id` is
  the internal cuid (FK target for `PricingHistory.cardId`/`CurrentPrice.cardId`).
  `Card.externalId` is the catalog id — the **TCGdex** id for Pokémon (`base1-4`) and the
  **Bandai** code for One Piece (`OP01-001`). **Scrydex uses its OWN third id namespace**
  (`me55c-4`), captured in the new `Card.scrydexId` column after `resolveScrydexCard`
  matches by name+number+set (§3.2a). The PokéWallet One Piece price fill is the ONLY join
  that keys on `externalId` directly (Bandai code == `card_number`, §4). The earlier claim
  that one `externalId` keys all three providers is removed. Never confuse the three.
- **Missing `SCRYDEX_TEAM_ID`:** header build throws (fail fast) — proven to 401 live;
  callers in the sync/backfill treat the thrown error as a failed pull (SyncLog).
- **Cloudflare hang on rapid Scrydex calls:** the sync/backfill space calls ≥ 3s; tests
  never hit the live API.

---

## 11. Files touched (summary)

Import from mainline then rewrite:
`src/lib/services/pokewallet.service.ts` (rewrite §2),
`src/lib/services/scrydex.service.ts` (rewrite §3.1–3.5),
`src/lib/services/sync-cards.service.ts` (rewire §4),
`scripts/scrydex-backfill.ts` (rewrite §8),
`prisma/schema.prisma` (enriched schema, §0.1 — + the additive `Card.scrydexId` column
(§3.2a) + `SyncLog @@index([job, cardId, ranAt])` (§3.6) + `db:push`),
`src/lib/services/card.service.ts` (EXPORT the existing `ApiTcgProduct` interface so the
sync's One Piece fetcher reuses it — finding #2; no behaviour change).

Note: `scrydex.service.ts` (§3) now exposes `resolveScrydexCard` + `fetchScrydexCardById`
instead of a single `fetchScrydexCard(externalId)` — Scrydex native-id resolution,
finding #1.

New:
`src/lib/services/scrydex-pricing.service.ts` (§3.6 orchestration + `SCRYDEX_STALE_MS`),
unit tests `pokewallet-price`, `scrydex-price`, `scrydex-trend-backfill`,
integration tests `scrydex-pricing`, `portfolio-snapshot`, `graded-routing`,
e2e `portfolio-real-chart`, `card-detail-chart` (+ extensions to scanner/graded specs),
`.agents/tasks/USER_TESTING_CHECKLIST.md` (FR-9).

New (continued):
`src/app/api/cards/[id]/graded/route.ts` (§6 — the Scrydex-backed graded price route;
no existing caller for `resolveGradedPrice` existed, finding #6).

Import unchanged (already correct on mainline):
`src/app/api/cards/recognize/route.ts` (reads `scrydexResult.cardId` — matches the
§3.1 field-name decision, finding #1).

Modified minimally (NOT "import unchanged" — the imported versions violate NFR-2/NFR-4,
findings #2/#3/#5):
`src/app/api/cards/[id]/prices/route.ts` (unknown/err → `{ prices: [] }` + HTTP 200, §7.1 finding #2),
`src/app/api/cards/[id]/history/route.ts` (filter null `priceMarket` instead of `?? 0`, §7.1 finding #3),
`src/app/api/users/me/collection/history/route.ts` (skip null prices in aggregation, §7.1 finding #3),
`src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` (real-line threshold `> 1` → `>= 1`, §7.1 finding #5),
`src/app/(dashboard)/search/[id]/page.tsx` (fetch `/api/cards/[id]/graded`, §6 client wiring),
`src/app/api/users/me/collection/route.ts` (add-snapshot write, non-null-priced only, §5).

**Docs to update in the same commit (AGENTS.md top rule):** `docs/API_REFERENCE.md`
(new `/api/cards/[id]/graded`; the now-200 `/api/cards/[id]/prices`; history, recognize
contract), `docs/ARCHITECTURE.md`
(§Data model: `CurrentPrice`/`SyncLog`/enriched `PricingHistory`; the Scrydex
store-and-reuse flow; price-fallback chain), `docs/CODE_MAP.md` (new service module +
tests). `.env.example` already lists the three keys (verified).

---

## 12. Open-question resolutions (summary)

- **OQ#0 (blocking):** Import the uncommitted mainline scaffold + enriched schema into
  the worktree; apply schema via `db:push` to the remote Supabase DB before e2e
  (medium-risk, additive, non-destructive). §0.1.
- **OQ#1 (portfolio snapshot):** No new table — write an `add-snapshot` `PricingHistory`
  point per added priced card; the existing history route aggregates `priceMarket ×
  quantity` on read. §5.
- **OQ#2 (trend backfill):** Absolute delta subtraction `market − price_change` for
  −1/−7/−14d; first pull per `[cardId,variant,condition]` only. §3.6.
- **OQ#3 (freshness window):** 24h Scrydex window, a **separate** constant from the
  7-day graded `STALE_AFTER_MS`. §3.6.
- **OQ#4 (Vision contingency):** Shipping with documented `null`→Tesseract fallback if
  no endpoint resolves is acceptable (AC-7 sanctions it). §3.5.
- **OQ#5 (DataSource enum vs free-text):** Trend points → `PricingHistory` only
  (`source:"scrydex-trend"`); `CurrentPrice` always `DataSource.SCRYDEX`. §3.6.

---

## 13. Response to design review (`design-review.json`, verdict CHANGES_REQUESTED)

Every HIGH and MEDIUM finding is **addressed**; both NITs are addressed too. No finding
is backlogged or dismissed — all were consistent with the requirements and verified
against the real code before fixing.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | `identifyCard` field (`externalId` vs `cardId`) mismatches `recognize/route.ts` | **Addressed.** Chose `cardId` (the name the route already reads). Defined `ScrydexIdentifyResult { cardId, … }` in §3.1 with a comment that the value is an externalId; `recognize/route.ts` stays unchanged (listed under "Import unchanged" in §11). Minimal-diff choice. §3.1, §3.5, §7. |
| 2 | HIGH | `/api/cards/[id]/prices` returns 404/500, violating NFR-4 | **Addressed.** Moved to "modified minimally"; both unknown-card and catch branches now return `{ prices: [] }` + HTTP 200 + `Cache-Control: no-store`, with an NFR-4 comment. §7.1, §11. |
| 3 | HIGH | Null prices coerced to 0 fabricate chart points (NFR-2) | **Addressed.** `cards/[id]/history` filters `priceMarket == null` before mapping; `collection/history` skips null rows in both the seed map and the daily total loop; add-snapshot writes only when price is non-null. All three files moved to "modified minimally"; pinned by `history-null-safe.test.ts`. §5, §7.1, §9.2, §11. |
| 4 | HIGH | Scrydex pulls use wrong game slug because sync never sets `Card.game` | **Addressed.** Catalog upsert now stamps `Card.game` (POKEMON for TCGdex, ONE_PIECE for apitcg) + `Card.source`; `gameSlug` maps `POKEMON→"pokemon"`, `ONE_PIECE→"onepiece"` literally; One Piece slug flagged UNVERIFIED with a required spaced live probe. §4, §9.1. |
| 5 | HIGH | Add-snapshot writes one point but dashboard needs `realHistory.length > 1` | **Addressed (review option a).** Lowered `DashboardClient` threshold to `>= 1` so one real point renders a short/flat real line; e2e assertion adjusted to "real series ≥1 point after add." `DashboardClient.tsx` moved to "modified." §5, §7.1, §9.3. |
| 6 | MED | Graded-price routing call site unspecified | **Addressed.** Grep proved `resolveGradedPrice`/`fetchPSAGradedPrice`/`gradedPrice` have NO caller; the only graded surface is a client-side heuristic in `search/[id]/page.tsx` (cannot call server code, NFR-5). Added a NEW server route `GET /api/cards/[id]/graded?grade=` that resolves game from the DB and runs `resolveGradedPrice` with a Scrydex `priceSource`; client fetches it. §6, §9.2, §11. |
| 7 | MED | apitcg One Piece set-walk fetchers under-specified | **Addressed.** Specified `GET /api/one-piece/sets` + `GET /api/products?tcg=one-piece&set={slug}` shapes, a Zod schema per response, the per-card `SyncCardInput` mapping from the apitcg product shape, `externalId = product.code` (Bandai code), and `NoResultsError`-on-empty. §4. |
| 8 | MED | Backfill idempotency: variant/condition casing disagreement | **Addressed.** Stated the single rule — verbatim from Scrydex, defaults `"normal"`/`"NM"` (schema defaults), owned by `pickRawPrice`. Rewritten backfill does ZERO direct writes and goes through `pullAndStoreScrydexPrice`, dropping the `"Near Mint"`/`"Normal"` literals. Pinned by `scrydex-price.test.ts`. §3.6 step 3, §8, §9.1. |
| 9 | MED | Freshness gate on `CurrentPrice` never trips for no-price cards | **Addressed.** Gate now reads the newest `SyncLog(job="scrydex_history", cardId).ranAt` (always written, incl. failed/empty pulls) as the authoritative throttle signal, not `CurrentPrice.updatedAt`. §3.6 step 1, §10. |
| 10 | MED | One Piece price-fill join key asserted, not shown | **Addressed.** Stated explicitly that `Card.externalId` (= `product.code`) is byte-identical to PokéWallet `card_number`; price fill is `priceMap.get(card.externalId)` with no normalization; set code derived from the externalId prefix. §4. |
| 11 | NIT | §0.1 self-contradicts on "verbatim"/"git checkout" | **Addressed.** Trimmed to one instruction: file-copy the listed untracked paths from the main checkout into the worktree, preserving relative paths. §0.1. |
| 12 | NIT | `db:push` lacks a rollback note | **Addressed.** Added the one-line rollback expectation (drop the 2 new tables, the added `pricing_history`/`Card` columns, and the 2 enums; data loss confined to re-derivable pricing). §0.1. |
| 13 | NIT | "Growth plan = 1 credit/call" assumed, not in contracts | **Addressed.** Modelled as a provisional named constant `SCRYDEX_CREDITS_PER_CALL = 1` with a `ponytail:` comment; the FR-7 pilot MEASURES the real figure and the implementer updates the constant. §3.6 step 5, §8. |

---

## 14. Response to design review 2 (`design-review.json`, verdict CHANGES_REQUESTED — this REVISION 3)

This is **Revision 3**, resolving the SECOND review (2 HIGH, 2 MEDIUM, 3 NIT) of
Revision 2. Every HIGH and MEDIUM is addressed; all three NITs are addressed. No finding
is backlogged — all were verified against the real source tree before fixing (apitcg
`images` array at `card.service.ts:461/504`; `fetchPokemonCardPrice(c.id)` call site at
`sync-cards.service.ts:427`; `SyncLog` has only `@@index([job, ranAt])`; `Card` has no
`scrydexId` column).

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | Scrydex single-card lookup keyed on the TCGdex externalId, but Scrydex uses its own id namespace | **Addressed (option a).** Replaced `fetchScrydexCard(externalId)` with `resolveScrydexCard({name,number,set,game})` (search → match on name+collector-number+set, use that result's `prices[]` directly, no 2nd call) + `fetchScrydexCardById(scrydexId)`. Added nullable `Card.scrydexId @unique` to cache the resolved id (additive, in the §0.1 push + rollback). Stated the explicit match rule and tie-break. Removed the §10 "one externalId keys all three providers" claim. §3.1, §3.2, §3.2a, §3.6 step 2, §6, §10, §11. |
| 2 | HIGH | apitcg `images` is an ARRAY, not an object; §4 Zod + mapping drop every One Piece card | **Addressed.** §4 now models `images: z.array(z.object({small,medium,large}.nullish())).nullish()` and maps `const img = product.images?.[0]; imageUrl = img?.large ?? img?.medium ?? img?.small ?? null` — identical to `fetchApiTcgOnePiece`. Mandated exporting/reusing the existing `ApiTcgProduct` interface from `card.service.ts` (added to §11 files) so shapes can't drift. §4, §11. |
| 3 | MED | `fetchPokemonCardPrice` signature change breaks the sync caller unless §4 rewrites the exact call site | **Addressed.** §4 names the exact edit: `listPokemonCardsInSet` changes `fetchPokemonCardPrice(c.id)` → `fetchPokemonCardPrice(c.name)`, keeping the `isActive` guard + `REQUEST_DELAY_MS` throttle. Added the name-collision caveat and why it is tolerable as a last-resort gap fill (Scrydex, resolving by name+number+set, carries the precise price). §4. |
| 4 | MED | Scrydex One Piece prices won't join (externalId is the Bandai code; same root as #1) | **Addressed.** Folded into #1's resolver, which covers both games (searches `/onepiece/v1/cards`, matches number+set). Documented the One Piece-slug-UNVERIFIED contingency: if the §4 probe shows a different slug/shape, scope Scrydex charts to Pokémon-only and document "One Piece chart empty = expected" in the user checklist — not a silent no-op. §3.2a, §4. |
| 5 | NIT | §9.2 freshness-gate test still asserted gating on `CurrentPrice`, contradicting §3.6's SyncLog decision | **Addressed.** §9.2 reworded to assert the skip when a recent `SyncLog(job='scrydex_history', cardId)` within `SCRYDEX_STALE_MS` exists; proceed when older/absent. §9.2. |
| 6 | NIT | Vision probe candidate list duplicated across §3.5 and contracts | **Addressed.** §3.5 now names the contracts' Vision section as the source of truth, probes only its not-yet-tried candidates, and skips the paths the contracts already record as 404'd. §3.5. |
| 7 | NIT | Freshness-gate query claimed an index on `SyncLog.cardId` that doesn't exist | **Addressed.** Added `@@index([job, cardId, ranAt])` to `SyncLog` (additive, in the §0.1 push + rollback), backing the exact gate query; removed the "indexed via the cardId FK" claim. §3.6 step 1, §0.1, §11. |
