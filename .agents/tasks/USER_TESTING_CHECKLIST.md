# Dojo — API Integration User Testing Checklist (FR-9)

A step-by-step manual script to confirm the external-data integration works end to
end: catalog, prices, real stored chart history, PSA graded pricing, and card
scanning. Each step lists the **exact expected result** and how to tell **real data**
from a graceful **"—"** (no-data) fallback.

---

## 0. The golden rule: "—" is honest, not a bug

This app **never fabricates data**. When a real source has no value for a card, the
price shows a literal **"—"** (em dash) and charts render an empty / flat line. That is
the correct behaviour, not a failure. A **$0** price or an invented number would be the
bug. So throughout this checklist:

- **Real data** = a dollar figure (e.g. `$191.34`), a chart line that moves, a tooltip
  with a real date + price.
- **Graceful fallback** = `—` for price, an empty-chart placeholder, "eBay unavailable",
  or a flat line. Expected whenever the upstream source has nothing for that card.

### Known caveats recorded during build (not bugs)

- **Card scanning uses on-device Tesseract OCR.** The Scrydex **Vision** image-match
  endpoint was probed live and **UNRESOLVED** (all candidate paths returned 404 as of
  the FEAT-001 probe). So `identifyCard()` returns null and the scanner falls back to
  Tesseract. Scan accuracy is therefore OCR-driven, and a scan may legitimately return
  **no confident match** — never a fabricated one.
- **Scrydex One Piece slug CONFIRMED** (`/onepiece/v1/cards?...&include=prices` returns
  200). One Piece price history **is** in scope — an empty One Piece chart means "no
  data yet for this card", not "scoped out".
- **Graded prices are not persisted** (only raw history is). A repeat view of a card's
  graded price within the 24h freshness window serves the curated fallback rather than
  burning a Scrydex credit — this is intentional.
- **Scrydex is rate-sensitive**: rapid repeated calls can trip Cloudflare and hang. The
  app spaces calls; when manually running the backfill, give it time.

### Environment prerequisites

- `.env` has: `DATABASE_URL`, `DIRECT_URL`, `BETTER_AUTH_SECRET`, `SCRYDEX_API_KEY`,
  `SCRYDEX_TEAM_ID`, `POKEWALLET_API_KEY`, `APITCG_API_KEY`, `PSA_API_KEY`.
- The enriched schema is applied to the DB (`npm run db:push` — adds `current_price`,
  `sync_log`, `card.scrydexId`, and the enriched `pricing_history`).
- Run the app on **port 3001** to match `BETTER_AUTH_URL` (`npm run build:standalone`
  then `node .next/standalone/server.js` with `PORT=3001`, or `npm run dev` on the
  matching port). Log in with a real email/password or Google account.

---

## 1. Catalog search — both games

**Pokémon**
1. Go to **/search**, pick game **Pokémon**, type a well-known card (e.g. `Charizard`).
2. **Expected:** result tiles appear with name, set, image, and either a price
   (`$…`) or **"—"** when no price is known. Tiles never show `$0`.

**One Piece**
3. Switch game to **One Piece**, search a leader (e.g. `Luffy`).
4. **Expected:** One Piece tiles appear (catalog via apitcg). Images load through the
   same-origin proxy. Price shows `$…` or **"—"**.

> Real-vs-"—": a tile with `$12.34` is a real catalog price; a tile with `—` means the
> catalog + gap-fill sources had no price for that card yet (not a bug).

---

## 2. Add to collection

1. From a search tile, tap the **"+" (Add to portfolio)** button (or open the detail
   page and use the quantity rows).
2. Pick a quantity and submit.
3. **Expected:** a success toast; the card appears in your collection on **/you** /
   portfolio, ordered newest-first. Adding several at once keeps your **selection order
   at the front** of the list.
4. **Behind the scenes (FR-5):** adding a **priced** card writes one real
   `add-snapshot` price point so the portfolio graph has a genuine datapoint from the
   moment of the add. Adding an **unpriced** card writes **no** snapshot (no fabricated
   $0) — the add still succeeds.

---

## 3. Portfolio average graph — real + grows on next pull

1. Open the **/dashboard** portfolio chart after adding at least one priced card.
2. **Expected:** the chart renders a **real series** (the portfolio value = sum over
   held cards of price × quantity). With one add-snapshot point it may be a short/flat
   line — that is a real line, not the old synthetic shape.
3. If your collection is empty or has only unpriced cards, **Expected:** the
   **empty-chart** placeholder (no crash, no fabricated values).
4. **Grows over time:** the portfolio value is captured when cards are added and as the
   daily sync pulls fresh Scrydex prices (store-once, reuse). Re-pulls within 24h are
   skipped, so the series grows at most ~once/day per card — it does **not** redraw from
   scratch every view.

> Real-vs-"—": a moving/known-value line = real; the empty-chart placeholder = no priced
> holdings yet.

---

## 4. Card-detail price + real chart

1. Open any card's detail page (tap a search tile).
2. **Expected:** the headline market price shows `$…` or **"—"**.
3. The **Price history** chart renders real stored points when they exist (e.g. the
   seeded harness card `Charizard` / `base1-4`). Hover (desktop) or tap (mobile) a point.
4. **Expected:** a tooltip shows that point's **real date + price**. If the card has no
   stored history, **Expected:** a flat/empty line and **no tooltip** — a valid "—"
   outcome, not a bug.

> Real-vs-"—": a tooltip with a real date/price = real stored history; a flat line with
> no tooltip = no history pulled for that card yet.

---

## 5. One Piece pricing via BerryWallet

1. Open a One Piece card detail (or inspect a One Piece tile price).
2. **Expected:** where apitcg has a TCGplayer price it shows directly; where it does not,
   the price is **gap-filled** from PokéWallet/BerryWallet (`/op/sets/{setCode}`), keyed
   by the Bandai card number. Cards with no price anywhere show **"—"**.

> Real-vs-"—": `$…` on a One Piece card = catalog or BerryWallet gap-fill; `—` = neither
> source had a price (expected, never fabricated).

---

## 6. Pokémon pricing via TCGdex → PokéWallet fallback

1. Open a Pokémon card detail that is likely to have a price (a popular modern card).
2. **Expected:** the price comes from the primary catalog source first; older/less-common
   cards with no primary price are gap-filled from PokéWallet (`/search?q=<name>`).
3. A card with no price in any source shows **"—"**.

> Real-vs-"—": `$…` = catalog or PokéWallet gap-fill; `—` = no price available (expected).

---

## 7. PSA graded via Scrydex

1. On a card detail page, look at the **Graded → PSA 10** row.
2. **Expected:** the PSA 10 price shows a dollar figure. When Scrydex has a live PSA 10
   market for the card, that is the value used (live-backed). When Scrydex has none, the
   row falls back to the curated graded table / coarse multiplier — still a sensible
   non-blank number, flagged internally as a fallback.
3. You can hit the route directly:
   `GET /api/cards/<externalId>/graded?grade=10` →
   `{ price, isFallback, isStale }`.
   - `isFallback: false` = a live Scrydex PSA price.
   - `isFallback: true` = curated/multiplier fallback (Scrydex had none or the 24h
     freshness window served stored data).
4. **Expected on an unknown/unpriced card:** `{ price: null, isFallback: true }` + HTTP
   **200** (never a 4xx/5xx). The UI shows its heuristic fallback, never a blank.

> Real-vs-"—": a graded price with `isFallback:false` = live Scrydex PSA; `isFallback:true`
> = best-known curated value (still shown, never blank).

---

## 8. Scanning via Scrydex Vision + Tesseract fallback

1. Go to **/scanner** (camera-enabled device or the fake-media test device). Frame a
   physical card inside the outline and tap **Scan**.
2. **Expected:** an "Is this your card?" list of the top candidates (name + set + image +
   % match) with a **Search manually** escape hatch.
3. **Important:** scanning currently runs through **on-device Tesseract OCR** because the
   Scrydex Vision endpoint is **unresolved** (see §0 caveats). So:
   - A clear, well-lit card usually yields a confident candidate.
   - A blurry/low-contrast card may yield **no confident match** — tap **Search
     manually**. This is expected; the app never invents a match.
4. Pick a candidate → it adds to your collection like any other card.

> Real-vs-"—": a candidate list = OCR found matches; "no match / search manually" = OCR
> could not read the card confidently (expected, not a bug).

---

## 9. Daily sync via GET /api/cron/sync-cards (CRON_SECRET-guarded)

1. Trigger a manual sync (the same endpoint Vercel Cron calls at 02:00 UTC):
   ```
   curl "http://localhost:3001/api/cron/sync-cards?secret=<CRON_SECRET>"
   ```
   (Or `Authorization: Bearer <CRON_SECRET>`. If `CRON_SECRET` is unset in local dev the
   route is open.)
2. **Expected:** a JSON summary of the run (sets processed, cards upserted). The sync:
   - refreshes the Pokémon catalog (TCGdex) + One Piece catalog (apitcg), stamping
     `Card.game` / `Card.source`;
   - gap-fills prices from PokéWallet/BerryWallet only where the catalog had none;
   - calls the Scrydex store-and-reuse pricing for **active** cards (in collections /
     want lists), bounded by the freshness window and the wall-clock budget, growing the
     real history series.
3. **Credit metering:** every Scrydex pull writes a `SyncLog(job="scrydex_history")` row
   (`status`, `credits`). Re-running the sync immediately pulls **no** new Scrydex prices
   (24h freshness gate) — expected.

### Optional: Scrydex backfill pilot (measures real credit cost)

1. Run `npx tsx scripts/scrydex-backfill.ts` (processes 10 collection-active cards,
   spaced ≥3s apart for Cloudflare).
2. **Expected:** a per-card ok/skip/fail summary + a **total credit** figure. Record it:
   if the measured per-pull cost differs from `1`, update `SCRYDEX_CREDITS_PER_CALL` in
   `scrydex-pricing.service.ts`. (As built it is provisional `1`.)
3. Re-running is idempotent — the freshness gate skips cards pulled within 24h.

---

## 10. Sign-off summary

| # | Feature | Pass when… |
|---|---------|-----------|
| 1 | Catalog search (both games) | Tiles show real prices or "—", never $0 |
| 2 | Add to collection | Toast + card in portfolio; priced card writes an add-snapshot |
| 3 | Portfolio average graph | Real series when priced holdings exist, else empty state |
| 4 | Card-detail price + chart | Real tooltip (date+price) when history exists, else flat line |
| 5 | One Piece pricing (BerryWallet) | Price or "—"; gap-fill where catalog lacks a price |
| 6 | Pokémon pricing (TCGdex→PokéWallet) | Price or "—"; PokéWallet fills gaps |
| 7 | PSA graded via Scrydex | PSA 10 row shows a price; `isFallback` distinguishes live vs curated; unknown → `null`+200 |
| 8 | Scanning (Vision→Tesseract) | Candidate list or an honest "no match" (Tesseract fallback) |
| 9 | Daily sync | Authorised run returns a summary; SyncLog metered; 24h gate throttles re-pulls |

Anything that shows a **"—"**, an empty chart, or an honest "no match" is **working as
designed** — those are the graceful fallbacks, not failures.
