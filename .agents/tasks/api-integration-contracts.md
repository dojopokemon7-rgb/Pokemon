# Verified External API Contracts — API Integration Task

> Captured by live probing on 2026-10-02. These are REAL, verified contracts.
> Do NOT guess endpoint shapes — use these. Re-probe live with the keys in `.env`
> only to discover the ONE remaining unknown (Scrydex Vision endpoint path).

## Credentials (all in `.env`, read via process.env — never hardcode)
- `SCRYDEX_API_KEY` — present and valid
- `SCRYDEX_TEAM_ID` = "dojo" — required on every Scrydex request
- `POKEWALLET_API_KEY` = `pk_live_...` — same key works for Pokémon + One Piece (BerryWallet)
- `APITCG_API_KEY` — One Piece CATALOG source (apitcg.com). LEAVE AS-IS, do not change.
- `PSA_API_KEY` — existing PSA cert-verify fallback

## Scrydex (api.scrydex.com) — VERIFIED

Auth: BOTH headers required together:
```
X-Api-Key: <SCRYDEX_API_KEY>
X-Team-ID: <SCRYDEX_TEAM_ID>
```
Current scrydex.service.ts uses `Authorization: Bearer` + `X-Team-ID` — WRONG. Fix to above.
Without X-Team-ID the API returns instant 401 {"error":{"code":"INVALID_CREDENTIALS"}}.

Base paths are per-game, legacy pokemontcg.io style:
- Pokémon:   `https://api.scrydex.com/pokemon/v1/...`
- One Piece: `https://api.scrydex.com/onepiece/v1/...`  (verify the slug by probing; pokemon confirmed)

### Search cards — VERIFIED
`GET /pokemon/v1/cards?q=name:charizard&pageSize=1&include=prices`
- Query uses legacy syntax `q=name:<term>` (colon), NOT `?name=`.
- `include=prices` is REQUIRED to get the prices array; omit it and prices are absent.
- Response: `{ data: [Card], page, page_size, count, total_count }`

### Single card — VERIFIED
`GET /pokemon/v1/cards/{id}?include=prices`
- Response: `{ data: Card }`

### Card shape (VERIFIED, trimmed to what we use)
```json
{
  "id": "me55c-4",
  "name": "Charizard",
  "types": ["Fire"],
  "hp": "120",
  "number": "4",
  "printed_number": "4/102",
  "rarity": "Rare Holo",
  "rarity_code": "R",
  "images": [{ "type":"front", "small":"https://images.scrydex.com/pokemon/me55c-4/small", "medium":"...", "large":"..." }],
  "expansion": { "id":"me55c", "name":"...", "series":"...", "code":"30C", "total":30, "release_date":"2026/09/16", "logo":"...", "symbol":"..." },
  "variants": [{
    "name": "holofoil",
    "marketplaces": [{ "name":"tcgplayer", "product_id":"714372", "purchase_url":"..." }],
    "pop_reports": [],
    "prices": [
      {
        "condition": "NM", "grade": null, "company": null,
        "is_perfect": false, "is_signed": false, "is_error": false,
        "type": "raw",            // "raw" = ungraded; graded entries have type!="raw"
        "low": 170.0, "mid": null, "high": null, "market": 191.34,
        "currency": "USD", "source_currency": "USD",
        "trends": {
          "days_1":  { "price_change": -7.33, "percent_change": -3.69 },
          "days_7":  { "price_change":  7.39, "percent_change":  4.02 },
          "days_14": { "price_change": 23.85, "percent_change": 14.24 }
        }
      }
      // GRADED entries (PSA) appear in the SAME prices[] array with:
      //   type != "raw", company: "PSA"|"CGC"|"BGS"|..., grade: "10"|"9"|...
    ]
  }]
}
```

### KEY MODELLING FACT — price history
Scrydex does NOT expose an arbitrary historical time-series endpoint on these paths
(`/prices/history/...` → 404). What it DOES give is: current `market`/`low` per
condition/variant, plus rolling `trends` (days_1 / days_7 / days_14 price_change +
percent_change) per price entry.

Implications for the "charts show real data, store once, reuse" requirement:
- On each Scrydex pull for a card, STORE a `PricingHistory` row (priceMarket, priceLow,
  source="scrydex", variant, condition, recordedAt=now) AND upsert `CurrentPrice`.
- History therefore ACCUMULATES one real point per pull per card over time. This is the
  honest "real data" series. The 1/7/14-day trend deltas can also be used to BACKFILL up
  to 3 synthetic-but-real-derived prior points (now, -1d, -7d, -14d) on the FIRST pull so
  a brand-new card shows a short real-derived line immediately. Mark backfilled points
  clearly (e.g. source="scrydex-trend") so they're distinguishable from fresh snapshots.
- "Don't re-fetch same card until stale": gate re-pulls with a freshness check. A card
  whose newest scrydex PricingHistory/CurrentPrice row is < STALE window old is skipped.
  Record every pull in SyncLog(job="scrydex_history", cardId, credits, status).

### GRADED / PSA pricing — route through Scrydex
Graded prices are entries in the same `variants[].prices[]` array where `type != "raw"`
and `company` names the grader (PSA). Pick the PSA entry matching the requested grade.
Keep the existing curated graded-price table (graded-price.ts) + PSA cert verify as the
OFFLINE fallback when Scrydex has no graded entry or the call fails.

### Vision / scanning — ENDPOINT UNKNOWN, must discover
scrydex.service.ts currently POSTs `/v1/vision/identify` (guess, returns 404).
Candidates that 404'd: /v1/vision/identify, /pokemon/v1/vision/match, /pokemon/v1/vision.
The docs (scrydex.com/docs) are a JS SPA and advertise a "Vision API".
ACTION for the coder: probe a FEW spaced POST paths with the live key + a real base64
image (space calls 3-5s apart — rapid repeats trip Cloudflare bot mitigation and hang).
Likely shapes to try: `/v1/vision`, `/pokemon/v1/vision/identify`, `/v1/image/match`,
`/pokemon/v1/cards/vision`. If none resolve, keep the existing graceful fallback: return
null so the scanner route tells the client to run on-device Tesseract (that path already
exists in src/app/api/cards/recognize/route.ts) — do NOT fabricate a match.

## BerryWallet / PokéWallet (api.pokewallet.io) — VERIFIED (PRICING ONLY)

Auth: `X-API-Key: <POKEWALLET_API_KEY>` (header). Current code uses the wrong
`.com/v1` domain + Authorization: Bearer — fix to `.io` + X-API-Key.

Use for PRICING ONLY. One Piece CATALOG stays on apitcg.com (card.service.ts). TCGdex
remains the primary Pokémon catalog + the first price attempt; BerryWallet/PokéWallet
fill price GAPS only.

### One Piece sets+prices — VERIFIED (free tier)
`GET /op/sets/{setCode}?page=1&limit=200`  (e.g. /op/sets/OP01)
Response: `{ success, set:{set_code,group_id,name,release_date}, total, page, limit, data: [card] }`
Card: `{ id:"op_...", card_number:"OP01-001", name, sub_type_name, rarity, card_type,
  ext_color, ext_power, ext_subtypes, tcgplayer:{ url, prices:{ low_price, market_price,
  high_price } }, cardmarket:{ prices:{ avg, low, trend } } }`
- CM-only sets (negative group_id): `tcgplayer: null`, ext_* null. Handle gracefully.
- All sets list: `GET /op/sets?language=en` → `{ success, data:[{name,set_code,group_id,release_date}], total }`
- Bulk `GET /op/prices?set_code=OP01` is a PRO feature — DO NOT rely on it. Use /op/sets/{code}.

### Pokémon price fallback — VERIFIED surface
`GET /search?q=charizard` (also `/op/search?q=` for One Piece). Returns search results
with tcgplayer/cardmarket prices. Use market_price. There is NO `/prices/pokemon/{id}`.

## TCGdex (api.tcgdex.net/v2/en) — already correct in tcgdex.service.ts
- `/sets`, `/sets/{id}` (set detail includes `cards[]`). Has NO prices (metadata/images only).
- So the fallback chain is: TCGdex (catalog+images, no price) → PokéWallet/BerryWallet (price only).

## One Piece catalog — apitcg.com — LEAVE AS-IS
card.service.ts fetchApiTcgOnePiece is the confirmed real catalog source. Do not replace.

## Cloudflare note
Rapid repeated automated calls to api.scrydex.com trigger a bot challenge that makes
requests HANG (not error). Space probe/test calls 3-5s apart. A single patient call
returns in ~0.3s.
