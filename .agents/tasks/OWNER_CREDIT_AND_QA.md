# Owner report — credit estimate, 20-card cross-check, manual QA

> Produced by the implementation pass. **No live Scrydex calls, scans, bulk
> refresh, or production migration were performed.** Everything below is either
> computed from documented costs or a template for you to fill during testing.
> Live credit spend stays BLOCKED until you approve it (see "Credit gate").

---

## 1. Credit gate — how live spend is controlled

Every credit-consuming Scrydex path refuses by default. The single enforcement
point is `src/lib/services/scrydex-credit-gate.ts`:

- **DENY by default.** With nothing set, price-history pulls, Vision identify,
  and sold-listings all return the empty/"pending approval" state instead of
  calling Scrydex.
- **To approve live spend**, set EITHER:
  - env `SCRYDEX_LIVE_CREDITS_APPROVED=true` (for a deliberate operator run), or
  - the Redis flag `scrydex:credit-approval` (admin toggle, no redeploy).
- **Scanner** additionally gates on this flag: with it off, the scanner returns
  `scan-pending-approval` and never calls Vision.

Documented per-operation costs (docs/SCRYDEX_AUDIT.md):

| Operation | Credits | Code path |
|---|---|---|
| Standard request (search / single card) | 1 | catalog reads |
| Price history (`/price_history`) | 3 | `pullAndStoreScrydexHistory` |
| Sold listings (`/listings`) | 1 | `/api/cards/[id]/ebay-sold` |
| Population (`include=pop_reports`) | 1 | manual refresh (not wired to auto) |
| Vision identify (`/vision/v1/cards/identify`) | 5 | scanner |

> Reminder: Scrydex usage counters update on a ~20–30 min delay, so measure real
> burn with a delayed `/account/v1/usage` read, not an instant before/after diff.

---

## 2. Bulk-refresh credit estimate (DO NOT RUN until approved)

A bulk refresh is the only large credit operation. Estimate, per card:

- current price + resolve: **1 credit** (one search-with-prices call), plus
- real RAW history: **3 credits** (one `/price_history` call), plus
- sold listings (if refreshed): **1 credit**.

So a full refresh is about **1–5 credits/card** depending on how much you pull:

| Scope per card | Credits/card | 1,000 cards | 10,000 cards | 50,000 cards |
|---|---|---|---|---|
| Current price only | 1 | 1,000 | 10,000 | 50,000 |
| Price + history | 4 | 4,000 | 40,000 | 200,000 |
| Price + history + sold | 5 | 5,000 | 50,000 | 250,000 |

**Compute YOUR exact number before approving:** run the read-only estimator,
which reads the local catalog count (no Scrydex calls):

```
npx tsx scripts/estimate-scrydex-bulk.ts
```

It prints the catalog size and the three scope totals above for your real
counts. The 24h freshness gate means a steady-state daily refresh only touches
cards older than 24h, so ongoing cost is far below a first full backfill.

---

## 3. 20-card cross-check (YOU do the comparison)

Pick 20 representative cards (mix of Pokémon + One Piece, raw + graded, popular
+ obscure). For each, record what Dojo shows vs what Scrydex/your reference
shows, and confirm before treating coverage as validated. Fill this table:

| # | Dojo Card.id | Dojo externalId | Scrydex id (cached) | Card / set / number | Variant | Current price + currency | Chart tiers present (RAW/PSA/BGS) | PSA pop status (English) | Sold listings status | Matches reference? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |  |  |  |
| … |  |  |  |  |  |  |  |  |  |  |
| 20 |  |  |  |  |  |  |  |  |  |  |

Things to specifically verify:
- **ID mapping (Audit L0):** does the Scrydex id equal `externalId`, or differ?
  Confirm the stored `scrydexId` vs `externalId` for a few cards. The code never
  assumes they're equal.
- **RAW chart = Near Mint**, other raw conditions shown as current prices below.
- **Graded series:** confirm whether PSA/BGS history series are drawable (Audit
  L2 unresolved). If labels aren't present in the response, graded series stay
  off — not fabricated.
- **BGS population:** must show "not available" (never a number).
- **Sold records:** real sold rows with dates, or "No recent sales found" — never
  active listings.
- **Currency:** current price converts to your USD/EUR profile; chart stays
  source-native with its own currency label.

---

## 4. Manual QA checklist (owner, hands-on)

Price / currency
- [ ] Switch profile currency USD↔EUR: current prices convert; charts stay
      source-native with a currency label.
- [ ] A JPY-source card shows JPY on the chart; current price converts to USD/EUR.
- [ ] With FX unavailable (block the FX host), current price shows source-native
      + a "conversion unavailable" indication (no fabricated number).

Charts (RAW / PSA / BGS)
- [ ] RAW chart plots Near Mint; other raw conditions appear as current prices.
- [ ] Gaps render honestly (no straight-line interpolation, no $0 points).
- [ ] No `scrydex-trend` fabricated points anywhere.

Scanner (scans 1–10 + edge cases)
- [ ] With credit approval ON: 10 successful scans decrement the allowance; the
      11th is refused ("limit reached").
- [ ] A no-match scan does NOT consume the allowance (count unchanged).
- [ ] Upload > 20MB → rejected; non-JPEG/PNG/WebP → rejected (no credit, no scan).
- [ ] With approval OFF: scanner says "pending approval", no Vision call.
- [ ] Scanned image is never saved to the portfolio / storage.

Portfolio sales / P&L
- [ ] Partial sale (e.g. sell 2 of 5): 3 stay active, 2 move to a Sold section in
      the SAME collection; quantity conserved.
- [ ] Realized P&L = gross proceeds − allocated cost basis (no fees/shipping).
- [ ] A card added with no price shows "unresolved" P&L (not $0); after a price
      refresh it resolves.
- [ ] Market Value / Paid / Realized / Unrealized read correctly; unresolved lots
      are flagged, not silently zeroed.

Search / detail
- [ ] Search by name, set, and card number all work; metadata is searchable.
- [ ] Top-line search icon is gone; Explore tab still opens search.
- [ ] Star (Want to Buy) + plus (add) both work on search tiles.
- [ ] Weekly change sort options appear and order correctly.
- [ ] Card detail: no Accessories block; "Recent Sales" shows sold records or
      "No recent sales found" (never active listings).

Collections / dashboard / onboarding
- [ ] Dashboard has NO Want-to-Buy/Sell/Trade intent sections; both lists are on
      /wantlist.
- [ ] A built-in "All Cards" view aggregates every owned card incl. unassigned;
      it can't be renamed/deleted (attempt → rejected).
- [ ] Multi-collection comparison chart draws one shaded area per collection
      (never summed); no value before a card entered a collection.
- [ ] First signup lands on Explore; Continue → add cards, Skip → Dashboard;
      either choice means the prompt never returns (test on a second device).

---

## 5. Known deferred items (need the running app + your visual judgment)

Backends/utilities are implemented and unit-tested; these final UI wirings were
left for hands-on iteration (noted so they're not mistaken for done):
- Multi-collection comparison chart wired to `buildCollectionSeries`.
- Portfolio stats panel consuming `aggregatePortfolio`; Sold-section + sell UI.
- Home chart shading/1-month range fix; home card-image click/loading fix.
