/**
 * PokéWallet / BerryWallet price client — PRICING ONLY (FR-1).
 *
 * Verified live contract (`.agents/tasks/api-integration-contracts.md`):
 *   - Base is `api.pokewallet.io` (NOT `.com/v1`).
 *   - Auth header is `X-API-Key` (NOT `Authorization: Bearer`).
 *   - One Piece prices come from `GET /op/sets/{setCode}?page=1&limit=200`.
 *   - Pokémon price GAP fallback is `GET /search?q=<name>` — there is NO
 *     `/prices/pokemon/{id}` endpoint.
 *
 * This service never owns catalog data: the One Piece catalog stays on
 * apitcg (card.service.ts) and TCGdex is the primary Pokémon catalog + first
 * price attempt. PokéWallet/BerryWallet only FILL price gaps. No path throws
 * to the sync engine — a failed fetch yields an empty Map / null so a missing
 * price simply stays `null` (AGENTS.md graceful degradation + never fabricate).
 */
import { z } from "zod";

const POKEWALLET_BASE_URL = "https://api.pokewallet.io";

function pokeWalletHeaders(): HeadersInit {
  const key = process.env.POKEWALLET_API_KEY;
  if (!key) throw new Error("POKEWALLET_API_KEY is not set.");
  return { "X-API-Key": key };
}

export interface OnePiecePrice {
  market: number | null;
  low: number | null;
  currency: string;
}

// --- Zod schemas mapping the REAL shapes (design §2.2) --------------------

// On CM-only sets (negative group_id) the whole `tcgplayer` object is null.
const OpTcgPlayerSchema = z
  .object({
    prices: z
      .object({
        low_price: z.number().nullish(),
        market_price: z.number().nullish(),
        high_price: z.number().nullish(),
      })
      .nullish(),
  })
  .nullable();

const OpCardMarketSchema = z
  .object({
    prices: z
      .object({
        avg: z.number().nullish(),
        low: z.number().nullish(),
        trend: z.number().nullish(),
      })
      .nullish(),
  })
  .nullish();

const OpCardSchema = z.object({
  id: z.string(),
  card_number: z.string(), // "OP01-001" — the key we map on
  name: z.string().optional(),
  tcgplayer: OpTcgPlayerSchema,
  cardmarket: OpCardMarketSchema,
});

const OpSetResponseSchema = z.object({
  success: z.boolean().optional(),
  set: z.object({ set_code: z.string(), group_id: z.number().optional() }).optional(),
  data: z.array(OpCardSchema),
});

// /search?q= Pokémon fallback — reuses the same tcgplayer/cardmarket block.
const PwSearchResultSchema = z.object({
  tcgplayer: OpTcgPlayerSchema,
  cardmarket: OpCardMarketSchema,
});
const PwSearchResponseSchema = z.object({ data: z.array(PwSearchResultSchema) });

// --- Pure helpers ----------------------------------------------------------

/** Finite number > 0 → that number, else null. Keeps bogus 0/NaN out. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Pick a One Piece price from a card entry (pure, unit-testable). Prefers
 * TCGplayer market/low, falls to Cardmarket avg/low, else null. NEVER throws
 * on a CM-only `tcgplayer: null` card — it falls through to cardmarket.
 */
export function pickOnePiecePrice(card: z.infer<typeof OpCardSchema>): OnePiecePrice {
  const tp = card.tcgplayer?.prices;
  const market = num(tp?.market_price) ?? num(card.cardmarket?.prices?.avg) ?? null;
  const low = num(tp?.low_price) ?? num(card.cardmarket?.prices?.low) ?? null;
  return { market, low, currency: "USD" };
}

// --- Public API ------------------------------------------------------------

/**
 * One Piece price for every card in a set, keyed by card_number ("OP01-001").
 * GET /op/sets/{setCode}?page=1&limit=200 — the free-tier surface.
 * Returns an empty Map on any failure (no price gap filled).
 */
export async function fetchOnePieceSetPrices(
  setCode: string
): Promise<Map<string, OnePiecePrice>> {
  const out = new Map<string, OnePiecePrice>();
  try {
    const res = await fetch(
      `${POKEWALLET_BASE_URL}/op/sets/${encodeURIComponent(setCode)}?page=1&limit=200`,
      { headers: pokeWalletHeaders(), next: { revalidate: 86400 } }
    );
    if (!res.ok) {
      console.warn(`[pokewallet] /op/sets/${setCode} HTTP ${res.status}`);
      return out;
    }
    const parsed = OpSetResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`[pokewallet] /op/sets/${setCode} parse failed: ${parsed.error.issues[0]?.message}`);
      return out;
    }
    for (const card of parsed.data.data) {
      out.set(card.card_number, pickOnePiecePrice(card));
    }
    return out;
  } catch (err) {
    console.warn(`[pokewallet] /op/sets/${setCode} error:`, err);
    return out;
  }
}

/**
 * Pokémon price GAP fallback by card name. GET /search?q=<name>.
 * Returns null on failure or zero results (never throws to the sync engine).
 */
export async function fetchPokemonCardPrice(name: string): Promise<OnePiecePrice | null> {
  try {
    const res = await fetch(
      `${POKEWALLET_BASE_URL}/search?q=${encodeURIComponent(name)}`,
      { headers: pokeWalletHeaders(), next: { revalidate: 3600 } }
    );
    if (!res.ok) {
      console.warn(`[pokewallet] /search?q=${name} HTTP ${res.status}`);
      return null;
    }
    const parsed = PwSearchResponseSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.data.length === 0) {
      console.warn(`[pokewallet] /search?q=${name} no usable result`);
      return null;
    }
    return pickOnePiecePrice(parsed.data.data[0] as z.infer<typeof OpCardSchema>);
  } catch (err) {
    console.warn(`[pokewallet] /search?q=${name} error:`, err);
    return null;
  }
}
