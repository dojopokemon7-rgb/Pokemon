/**
 * Scrydex client — card resolution, raw/graded pricing, Vision identify
 * (FR-2 + FR-4). THIN CLIENT: maps shapes + Zod only, NO Prisma. The DB
 * writes / freshness gate / credit metering live in scrydex-pricing.service.ts
 * (AGENTS.md §5.11 "services own side effects, clients map shapes").
 *
 * Verified live contract (`.agents/tasks/api-integration-contracts.md`):
 *   - Base is `api.scrydex.com`; paths are per-game legacy pokemontcg.io style:
 *     `/pokemon/v1/...` and `/onepiece/v1/...`.
 *   - Auth requires BOTH `X-Api-Key` AND `X-Team-ID` on every request
 *     (missing team id → instant 401 INVALID_CREDENTIALS).
 *   - Search uses legacy colon syntax `q=name:<term>`; `include=prices` is
 *     REQUIRED or the prices array is absent — this client always appends it.
 *   - There is NO history endpoint (`/prices/history/...` → 404). History is
 *     store-and-accumulate (scrydex-pricing.service.ts); `fetchPriceHistory`
 *     is deleted.
 *
 * ID NAMESPACES (AGENTS.md non-negotiable #3 — three distinct ids):
 *   Scrydex uses its OWN native id ("me55c-4"), NOT Card.externalId (TCGdex
 *   "base1-4" / Bandai "OP01-001"). So we NEVER pass externalId to the
 *   by-id endpoint — resolveScrydexCard() searches by name and matches on
 *   number+set to find the native id, which the caller caches on Card.scrydexId.
 *
 * VISION ENDPOINT: UNRESOLVED as of 2026-10-02 (see FEAT-001 probe findings).
 *   None of the candidate POST paths returned a usable match, so identifyCard
 *   returns null and recognize/route.ts falls back to on-device Tesseract.
 *   (That fallback is verified to exist in recognize/route.ts.) When a Vision
 *   path is confirmed, wire it here + Zod-parse the body + name the path in a
 *   load-bearing comment. Never fabricate a match.
 */
import { z } from "zod";
import { Game } from "@prisma/client";
import { parseGrade } from "@/lib/utils/graded-price";

const SCRYDEX_BASE_URL = "https://api.scrydex.com";

function scrydexHeaders(): HeadersInit {
  const key = process.env.SCRYDEX_API_KEY;
  const team = process.env.SCRYDEX_TEAM_ID;
  if (!key) throw new Error("SCRYDEX_API_KEY is not set.");
  if (!team) throw new Error("SCRYDEX_TEAM_ID is not set."); // both required or instant 401
  return { "X-Api-Key": key, "X-Team-ID": team };
}

/** Prisma Game enum → the per-game path slug. */
function gameSlug(game: Game): "pokemon" | "onepiece" {
  return game === Game.ONE_PIECE ? "onepiece" : "pokemon";
}

// --- Zod schemas mapping the REAL shape (design §3.2) ---------------------

const TrendDeltaSchema = z
  .object({
    price_change: z.number().nullish(),
    percent_change: z.number().nullish(),
  })
  .nullish();

const PriceEntrySchema = z.object({
  condition: z.string().nullish(),
  grade: z.string().nullish(),
  company: z.string().nullish(),
  type: z.string(), // "raw" = ungraded; else graded
  low: z.number().nullish(),
  market: z.number().nullish(),
  currency: z.string().default("USD"),
  trends: z
    .object({ days_1: TrendDeltaSchema, days_7: TrendDeltaSchema, days_14: TrendDeltaSchema })
    .nullish(),
});

const VariantSchema = z.object({
  name: z.string().default("normal"),
  prices: z.array(PriceEntrySchema).default([]),
});

const ScrydexCardSchema = z.object({
  id: z.string(), // Scrydex-native id ("me55c-4"), NOT the TCGdex externalId
  name: z.string(),
  number: z.string().nullish(), // collector number — the match key
  printed_number: z.string().nullish(),
  expansion: z
    .object({ id: z.string().nullish(), name: z.string().nullish(), code: z.string().nullish() })
    .nullish(), // set code/name — the match key
  variants: z.array(VariantSchema).default([]),
});

const ScrydexSingleCardResponseSchema = z.object({ data: ScrydexCardSchema });
const ScrydexSearchResponseSchema = z.object({
  data: z.array(ScrydexCardSchema).default([]),
  total_count: z.number().nullish(),
});

export type ScrydexCard = z.infer<typeof ScrydexCardSchema>;
type ScrydexTrends = z.infer<typeof PriceEntrySchema>["trends"];

// --- Public types ----------------------------------------------------------

export interface ScrydexRawPrice {
  market: number | null;
  low: number | null;
  currency: string;
  trends: ScrydexTrends | null;
  variant: string;
  condition: string;
}

export interface ScrydexGradedPrice {
  market: number | null;
  low: number | null;
  currency: string;
  company: string;
  grade: string;
}

/**
 * FR-2d Vision identify result. The id field is `cardId` and carries the
 * EXTERNAL catalog id (NFR-3) — the name recognize/route.ts already reads
 * (`scrydexResult.cardId` → `where: { externalId }`), so the route stays
 * UNCHANGED. The value is an externalId despite the field name.
 */
export interface ScrydexIdentifyResult {
  cardId: string;
  confidence: number;
  name: string;
  setCode: string;
}

// --- Helpers ---------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Normalize a collector number for matching: strip any "/total" suffix and
 * leading zeros. Dojo Card.number can be "4" or "4/102"; Scrydex `number` is
 * the bare "4".
 */
function normNumber(n: string | null | undefined): string {
  if (!n) return "";
  const base = n.split("/")[0].trim();
  return base.replace(/^0+(?=\d)/, "").toLowerCase();
}

// --- Resolution + fetch ----------------------------------------------------

/**
 * Resolve a Dojo card to a Scrydex-native card id by SEARCH (design §3.2a).
 *
 * `setCode` is OPTIONAL and effectively One-Piece-only (derived from the
 * Bandai externalId prefix); for Pokémon we match on setName + number, since
 * the TCGdex externalId is not the Scrydex expansion code (NIT-3). We search
 * by name and match on collector number + set, then use the matched entry's
 * prices[] DIRECTLY (search carries prices when include=prices, so NO 2nd
 * call — saves a credit). Returns the matched card + its native id, or null.
 */
export async function resolveScrydexCard(card: {
  name: string;
  number: string;
  setName?: string;
  setCode?: string;
  game: Game;
}): Promise<{ scrydexId: string; card: ScrydexCard } | null> {
  const slug = gameSlug(card.game);
  try {
    const res = await fetch(
      `${SCRYDEX_BASE_URL}/${slug}/v1/cards?q=name:${encodeURIComponent(card.name)}&pageSize=25&include=prices`,
      { headers: scrydexHeaders() }
    );
    if (!res.ok) {
      console.warn(`[scrydex] resolve ${card.name} HTTP ${res.status}`);
      return null;
    }
    const parsed = ScrydexSearchResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`[scrydex] resolve ${card.name} parse failed: ${parsed.error.issues[0]?.message}`);
      return null;
    }

    const wantNum = normNumber(card.number);
    const entries = parsed.data.data;

    const numberMatches = entries.filter(
      (e) => normNumber(e.number ?? e.printed_number) === wantNum
    );

    // number + set match (set tie-breaks when numbers collide across sets).
    const numberAndSet = numberMatches.filter((e) => {
      if (card.setCode) return e.expansion?.code === card.setCode;
      if (card.setName) return (e.expansion?.name ?? "").toLowerCase() === card.setName.toLowerCase();
      return false;
    });

    let matched: ScrydexCard | undefined;
    if (numberAndSet.length >= 1) {
      matched = numberAndSet[0]; // one or several variants of same printing → first
    } else if (numberMatches.length === 1) {
      matched = numberMatches[0]; // set wording differed, but number is unique
    }

    if (!matched) return null; // never guess
    return { scrydexId: matched.id, card: matched };
  } catch (err) {
    console.warn(`[scrydex] resolve ${card.name} error:`, err);
    return null;
  }
}

/**
 * Fetch a card incl. prices by its SCRYDEX-NATIVE id (used only after
 * resolveScrydexCard has cached a scrydexId on the Card).
 * GET /{slug}/v1/cards/{scrydexId}?include=prices
 */
export async function fetchScrydexCardById(
  scrydexId: string,
  game: Game
): Promise<ScrydexCard | null> {
  const slug = gameSlug(game);
  try {
    const res = await fetch(
      `${SCRYDEX_BASE_URL}/${slug}/v1/cards/${encodeURIComponent(scrydexId)}?include=prices`,
      { headers: scrydexHeaders() }
    );
    if (!res.ok) {
      console.warn(`[scrydex] fetchById ${scrydexId} HTTP ${res.status}`);
      return null;
    }
    const parsed = ScrydexSingleCardResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`[scrydex] fetchById ${scrydexId} parse failed: ${parsed.error.issues[0]?.message}`);
      return null;
    }
    return parsed.data.data;
  } catch (err) {
    console.warn(`[scrydex] fetchById ${scrydexId} error:`, err);
    return null;
  }
}

// --- Price accessors (pure) ------------------------------------------------

/**
 * FR-2b: raw/NM market+low from the first type==="raw" entry that has a
 * finite market or low. variant/condition verbatim from the Scrydex entry
 * (defaults "normal"/"NM" — the schema @default values). Null when absent.
 */
export function pickRawPrice(card: ScrydexCard): ScrydexRawPrice | null {
  for (const variant of card.variants) {
    for (const entry of variant.prices) {
      if (entry.type !== "raw") continue;
      const market = num(entry.market);
      const low = num(entry.low);
      if (market === null && low === null) continue;
      return {
        market,
        low,
        currency: entry.currency || "USD",
        trends: entry.trends ?? null,
        variant: variant.name || "normal",
        condition: entry.condition || "NM",
      };
    }
  }
  return null;
}

/**
 * FR-2c: PSA (or other company) graded entry matching a requested grade.
 * Filters type!=="raw" && company===(company??"PSA") && grade matches
 * (reusing graded-price parseGrade for "PSA 10"→10). Null when absent.
 */
export function pickGradedPrice(
  card: ScrydexCard,
  grade: string | number,
  company?: string
): ScrydexGradedPrice | null {
  const wantCompany = (company ?? "PSA").toUpperCase();
  const wantGrade = parseGrade(grade);
  for (const variant of card.variants) {
    for (const entry of variant.prices) {
      if (entry.type === "raw") continue;
      if ((entry.company ?? "").toUpperCase() !== wantCompany) continue;
      if (entry.grade == null) continue;
      if (parseGrade(entry.grade) !== wantGrade) continue;
      return {
        market: num(entry.market),
        low: num(entry.low),
        currency: entry.currency || "USD",
        company: wantCompany,
        grade: entry.grade,
      };
    }
  }
  return null;
}

// --- Vision ----------------------------------------------------------------

/**
 * FR-2d: Vision identify from a base64 image (prefix already stripped by the
 * caller). Returns ScrydexIdentifyResult where `cardId` is the EXTERNAL
 * catalog id (load-bearing: recognize/route.ts reads scrydexResult.cardId
 * and matches it against Card.externalId, so this field name must not change).
 *
 * Vision endpoint UNRESOLVED as of 2026-10-02 — the probe found no working
 * path, so this returns null and the route degrades to on-device Tesseract.
 * Wire the endpoint here (+ Zod-parse body) once a path is confirmed.
 */
export async function identifyCard(imageBase64: string): Promise<ScrydexIdentifyResult | null> {
  void imageBase64;
  return null;
}
