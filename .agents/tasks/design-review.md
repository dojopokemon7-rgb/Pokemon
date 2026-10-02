# Design Review — External API Integration (Revision 3)

Reviewer: fresh-eyes design review subagent. Scope: `design.md` (Revision 3) against
`requirements.md`, the verified contracts (`.agents/tasks/api-integration-contracts.md`),
and `AGENTS.md`. Every structural claim below was checked against the real source tree
(mainline checkout `d:\…\Pokemon` and the worktree) — not taken on the design's word.

## Verdict summary

This is a strong Revision 3 that has genuinely resolved both prior review rounds. The
hard contract facts (Scrydex dual-header auth, no history endpoint, inline
`variants[].prices[]`, apitcg `images` array, PokéWallet `.io` + `X-API-Key`, the
three-id-namespace reality) are all accurately reflected and verified. The remaining
findings are concentrated in ONE place the design added new in Rev 3: the new
`GET /api/cards/[id]/graded` route (§6), which — unlike every other Scrydex caller —
has no freshness gate, no SyncLog metering, and no scrydexId write-back, so it burns a
Scrydex search credit on every public hit. That is a real NFR-8 (credit discipline)
gap and a direct inconsistency with the design's own centralise-the-writer principle.

Counting HIGH + MEDIUM below (> 0) ⇒ **CHANGES_REQUESTED**.

---

## Findings

### 1. MEDIUM — `GET /api/cards/[id]/graded` (§6) burns a Scrydex credit on every public hit; no freshness gate, no SyncLog, no scrydexId write-back

**Where:** design.md §6, the `GET /api/cards/[id]/graded/route.ts` code block.

**Problem:** The route calls, on every request where `card.scrydexId` is null,
`resolveScrydexCard({ name, number, setName, game })` — which the design itself
defines as a live Scrydex **search** call costing one credit (§3.6 step 5,
`SCRYDEX_CREDITS_PER_CALL`). This route:
- has **no freshness gate** (the §3.6 gate lives only in `pullAndStoreScrydexPrice`,
  which this route does NOT call),
- writes **no `SyncLog`** row, so these credits are invisible to the metering that
  FR-7 / AC-12 exist to protect,
- never persists the resolved id back to `Card.scrydexId`, so even a repeat hit on the
  SAME card re-searches (the cache the design built in §3.2a is bypassed here).

It is a *public* card route (NFR-4, returns 200), so it can be hit on every card-detail
page view by any unauthenticated visitor. That directly contradicts NFR-8 ("gate
Scrydex pulls with the freshness window to minimise credit burn") and the design's own
§3.6 "Invariant ownership … centralising them is why the backfill script and the sync
engine can both call `pullAndStoreScrydexPrice` without duplicating the guard." The
graded route is a THIRD Scrydex caller that bypasses that centralisation.

**Fix (choose one, state it):**
(a) Route the graded price through the stored data: call `pullAndStoreScrydexPrice`
(force=false) first so the freshness gate + SyncLog + scrydexId write-back all apply,
then read the graded entry from the just-pulled/cached `ScrydexCard` — but note
`pullAndStoreScrydexPrice` currently only returns `{ pulled, credits }`, so it would
need to also return the resolved `ScrydexCard` (or the graded route reads a stored
graded `CurrentPrice`/`PricingHistory` row). This is the lazy, consistent choice.
(b) At minimum: when the graded route resolves via `resolveScrydexCard`, (i) write the
resolved `scrydexId` back to `Card`, (ii) write a `SyncLog(job="scrydex_history",
cardId, credits, status)` row, and (iii) short-circuit on the §3.6 freshness gate
(reuse `SCRYDEX_STALE_MS` against the newest SyncLog) so repeat views within 24h serve
the stored graded price instead of re-searching. Add a Redis cache for the graded
response if you want sub-24h protection (NFR-7 try/catch optional).
Whichever path, the design must state that the graded route obeys the SAME freshness
gate + SyncLog metering as every other Scrydex caller.

---

### 2. MEDIUM — Graded route passes no `setCode` to `resolveScrydexCard`, silently degrading the §3.2a match to the weaker name-only tie-break for the exact feature that most needs precision

**Where:** design.md §6 route code
(`resolveScrydexCard({ name: card.name, number: card.number, setName: card.set?.name ?? undefined, game: card.game })`)
vs §3.2a match rule (set match "prefer `entry.expansion.code === card.setCode` when
`card.setCode` is known, else case-insensitive `entry.expansion.name`").

**Problem:** The §3.2a resolver's strongest disambiguator is `setCode` (an exact code
match like `"OP01"` / set code), with `setName` as a looser case-insensitive fallback.
The graded route's `select` pulls `set: { select: { name: true } }` only and passes
`setName` but **not** `setCode`, so for graded lookups the resolver always runs on the
weaker name-match branch. Graded (PSA) pricing is a high-value, per-printing-sensitive
number where picking the wrong set's printing is worse than for a raw gap-fill. The
design does not acknowledge this degradation, and `CardSet` has no `code` column on the
verified schema anyway (so `setCode` is not trivially available) — which is itself
unstated.

**Fix:** State explicitly where `card.setCode` comes from for the Scrydex match. Either
(a) document that `setCode` is NOT available from the Dojo schema (`CardSet` has only
`name`/`externalId`), so the match necessarily relies on `setName` + collector number,
and confirm that is acceptable for graded; or (b) derive a set code where possible
(e.g. One Piece `externalId` prefix `"OP01-001"→"OP01"`) and pass it. Make the §3.2a
"prefer setCode" rule's input source concrete rather than referencing a field no caller
populates.

---

### 3. NIT — §3.2a match rule references `card.setCode`, but no `CardSet.code`/`Card.setCode` field exists on the verified schema

**Where:** design.md §3.2a step 2 ("prefer `entry.expansion.code === card.setCode`
when `card.setCode` is known") and the `resolveScrydexCard` signature
(`{ …; setCode?: string }`).

**Problem:** Verified against `prisma/schema.prisma` (mainline, enriched): `CardSet`
has `externalId`, `name`, `series` — **no `code`** column; `Card` has no `setCode`.
So `card.setCode` is `undefined` for essentially every caller unless derived. The
resolver's optional `setCode?` is fine as an interface, but the design presents the
setCode branch as the primary match path without noting that nothing populates it
today. This is the schema-level root of finding #2.

**Fix:** Add one sentence in §3.2a: "`setCode` is optional and currently only
derivable for One Piece from the externalId prefix; Pokémon matches run on
`setName` + collector number." Keeps the match rule honest about which branch actually
fires.

---

### 4. NIT — `fetchScrydexCardById` branch in the graded route builds `{ card }` without the `scrydexId`, so the design's return-shape contract is inconsistent between the two resolve paths

**Where:** design.md §6 route:
`const resolvedScrydex = card.scrydexId ? { card: await fetchScrydexCardById(...) } : await resolveScrydexCard(...)`.

**Problem:** `resolveScrydexCard` returns `{ scrydexId, card }` (§3.1); the by-id
branch returns `{ card }` (no `scrydexId`). The route then reads only
`resolvedScrydex?.card`, so it works — but the two branches have different shapes,
which is a latent trap if a future edit reads `resolvedScrydex.scrydexId`. Also
`fetchScrydexCardById` can return `null` (§3.1), so `{ card: null }` is possible and
handled by `?? null` — fine, but undocumented.

**Fix:** Normalise the branch to a single `ScrydexCard | null` local
(`const scrydexCard = card.scrydexId ? await fetchScrydexCardById(card.scrydexId, card.game) : (await resolveScrydexCard(...))?.card ?? null;`),
dropping the mismatched wrapper object. One line, removes the shape divergence.

---

### 5. NIT — `recognize/route.ts` is listed "Import unchanged (already correct on mainline)" but is DIFFERENT in the worktree; the instruction is correct only if read as "copy mainline over worktree"

**Where:** design.md §11 "Import unchanged (already correct on mainline):
`src/app/api/cards/recognize/route.ts`".

**Problem:** Verified by file hash: the worktree's `recognize/route.ts` differs from
mainline's. The mainline version is the one that calls `identifyCard` +
`scrydexResult.cardId` (correct). "Import unchanged" is ambiguous between "already in
the worktree, leave it" (false — the worktree has the older version) and "copy the
mainline version in and then don't edit it further" (the intended meaning). An
implementer who reads it as the former would ship the stale worktree version and the
Scrydex Vision wiring would silently not exist.

**Fix:** Reword §11 to: "Copy from mainline (the mainline version already reads
`scrydexResult.cardId`); no further edits after import." Confirms the file must be
brought over, not left as-is in the worktree.

---

## Verified Assumptions (checked against the real source tree)

1. **Scrydex dual-header auth, no history endpoint, inline `variants[].prices[]` with
   `type`/`company`/`grade`/`trends`** — matches the verified contracts file. Design
   §3 reflects it faithfully.
2. **apitcg `images` is an ARRAY** `Array<{small?,medium?,large?}>` — verified at
   `card.service.ts` (`images?: Array<{…}>` and `const img = p.images?.[0]`). Design §4
   Zod + mapping (`product.images?.[0]`, `img?.large ?? img?.medium ?? img?.small`)
   is correct.
3. **`ApiTcgProduct` interface exists in `card.service.ts` and is NOT currently
   exported** (`interface ApiTcgProduct`, no `export`). Design §4/§11 mandate exporting
   and reusing it — correct and necessary.
4. **`fetchPokemonCardPrice(c.id)` call site** is at `sync-cards.service.ts:427` inside
   `listPokemonCardsInSet`, guarded by `isActive` + `sleep(REQUEST_DELAY_MS)`. Design
   §4's exact-call-site edit (`c.id` → `c.name`) is correct.
5. **Enriched schema is present on the MAINLINE checkout**: `Game`, `DataSource`
   (`TCGDEX`/`POKEWALLET`/`SCRYDEX`), `Card.game` + `Card.source`, enriched
   `PricingHistory` (`priceMarket`/`priceLow`/`source` free-text/`currency`/`variant`/
   `condition`, unique `[cardId, recordedAt, source, currency, variant, condition]`),
   `CurrentPrice` (`source` is the `DataSource` enum, unique
   `[cardId, source, currency, variant, condition]`), `SyncLog`
   (`job`/`cardId`/`status`/`credits`/`error`/`ranAt`, `@@index([job, ranAt])`).
   Design §0.1's "verified by reading the file" claim is TRUE.
6. **Mainline schema has NO `Card.scrydexId`** and **SyncLog has only
   `@@index([job, ranAt])`** (no `cardId` index). Design §3.2a / §3.6 correctly add
   both as additive edits.
7. **Worktree committed schema has the OLD `PricingHistory`** (single `price Float`,
   `source` free-text, no `CurrentPrice`/`SyncLog`). Confirms OQ#0 is a real blocker;
   §0.1's copy-in + `db:push` resolution is sound.
8. **`resolveGradedPrice` signature** `{ cardName, setName, grade, rawMarketPrice,
   lastPricedAt?, priceSource?: () => number|null|undefined } → { price, isStale,
   isFallback }` — verified. The §6 route call matches it exactly. `STALE_AFTER_MS` =
   7 days, confirming OQ#3's "separate constant from the 24h Scrydex window."
9. **`resolveGradedPrice`/`getGradedPrice`/`gradedPrice` have NO production caller** —
   grep across the repo finds only the util definition, its unit test, docs, and the
   task files. Design §6 finding-#6 "dead function, new route required" is TRUE.
10. **`search/[id]/page.tsx` client PSA heuristic** `const psa10Multiplier = 2 + 50 /
    (rawPrice + 10)` at line 550 with the "TODO Week 3: replace with real graded
    pricing data" comment — verified. Design §6's quote and "cannot call server code
    (NFR-5)" rationale are correct.
11. **`recognize/route.ts` (mainline) reads `scrydexResult.cardId` and uses it as
    `where: { externalId: scrydexResult.cardId }`** — verified. Design §3.1's decision
    to name the field `cardId` (carrying an externalId) so the route stays unchanged is
    correct and minimal.
12. **`collection/route.ts` POST** uses `assignBulkAddOrder`, looks up by `externalId`,
    processes per-item in a loop, and has `item.marketPrice` / `card.marketPrice`
    available (line 225). Design §5's `addPrice = item.marketPrice ?? card.marketPrice`
    per-card snapshot write is feasible exactly as described.
13. **`collection/history/route.ts` (mainline)** aggregates `Σ(priceMarket × quantity)`
    per day and coerces null→0 in two places (`row.priceMarket ?? 0`,
    `lastSeenPrices.get(cardId) || 0`), with a 500 catch and `isSold: false` filter —
    verified. Design §7.1's NFR-2 fix (skip null rows, keep the authed-route 500) is
    accurate and well-targeted.

## Unverified / Wrong Assumptions

1. **`Card.setCode` / `CardSet.code` existence** — the §3.2a match rule's preferred
   `setCode` branch references a field that does NOT exist on the verified schema
   (findings #2/#3). Not wrong per se (the interface field is optional), but the design
   presents it as a primary match path without noting nothing populates it. Needs the
   one-sentence clarification in finding #3.
2. **One Piece Scrydex slug `"onepiece"`** — correctly flagged by the design itself as
   UNVERIFIED (contracts confirm `pokemon` only); the required spaced live probe +
   Pokémon-only contingency is documented (§3.2a / §4). Left to the implementation
   step as designed; not a review blocker.
3. **Vision endpoint path** — correctly flagged UNKNOWN by the design; the
   null→Tesseract contingency (§3.5, AC-7) is sanctioned by the requirements. Not a
   blocker.
4. **`SCRYDEX_CREDITS_PER_CALL = 1`** — correctly flagged PROVISIONAL (finding #13 of
   the prior round) with the FR-7 pilot measuring the real figure. Not a blocker.
   (The graded route in finding #1 is the place where even this provisional metering is
   skipped entirely.)
