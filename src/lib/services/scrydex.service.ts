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
 *   - A documented price-history endpoint DOES exist and IS wired here:
 *     `GET /{slug}/v1/cards/{id}/price_history` (3 credits/call, credit-gated).
 *     See `fetchScrydexPriceHistory` below and `pullAndStoreScrydexHistory` in
 *     scrydex-pricing.service.ts. (The legacy `/prices/history/...` path 404s
 *     and the old `fetchPriceHistory` is gone — but real multi-point history is
 *     available via the endpoint named above, NOT store-and-accumulate only.)
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

export function scrydexHeaders(): HeadersInit {
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

// --- Price history (documented endpoint) -----------------------------------

/**
 * Scrydex price-history point as returned by
 * GET /{slug}/v1/cards/{id}/price_history (DOC-VERIFIED — see
 * docs/SCRYDEX_AUDIT.md). Each `data[]` entry is one date carrying a `prices[]`
 * array of per-variant/condition points. We Zod-parse at the boundary and drop
 * anything that fails (AGENTS.md §5.4). source currency preserved; NEVER
 * FX-converted downstream.
 *
 * UNRESOLVED (Audit L2): the documented sample showed ONLY type:"raw" points
 * with no company/grade labels. Whether graded points are labeled in the
 * RESPONSE (vs only accepted as request filters) is unconfirmed — so this
 * client surfaces whatever Scrydex returns verbatim and the caller MUST NOT
 * fabricate graded series from it.
 */
const PriceHistoryPointSchema = z.object({
  variant: z.string().nullish(),
  condition: z.string().nullish(),
  type: z.string().nullish(),
  company: z.string().nullish(),
  grade: z.string().nullish(),
  low: z.number().nullish(),
  market: z.number().nullish(),
  currency: z.string().nullish(),
});
const PriceHistoryDaySchema = z.object({
  date: z.string(),
  prices: z.array(PriceHistoryPointSchema).default([]),
});
const PriceHistoryResponseSchema = z.object({
  data: z.array(PriceHistoryDaySchema).default([]),
  total_count: z.number().nullish(),
});
export type ScrydexHistoryDay = z.infer<typeof PriceHistoryDaySchema>;

export interface ScrydexHistoryFilters {
  days?: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  variant?: string;
  condition?: string;
  company?: string;
  grade?: string;
  pageSize?: number;
}

/**
 * Fetch a card's REAL price history from the documented endpoint
 * `GET /{slug}/v1/cards/{id}/price_history` (3 credits per call — Audit).
 *
 * `id` MUST be the Scrydex-returned card id (NOT assumed equal to
 * Card.externalId — Audit L0 / Req 6.6). Server-side only (uses scrydexHeaders).
 *
 * CREDIT SAFETY: this performs a live, metered Scrydex call. It is NOT invoked
 * automatically by the daily sync in this phase; callers must gate it behind
 * Owner_Approval with an explicit credit estimate (Checkpoint D). Returns the
 * validated days (possibly empty = honest no-history), or null on failure so
 * the caller degrades gracefully (never fabricates).
 */
export async function fetchScrydexPriceHistory(
  id: string,
  game: Game,
  filters: ScrydexHistoryFilters = {}
): Promise<ScrydexHistoryDay[] | null> {
  const slug = gameSlug(game);
  const qs = new URLSearchParams();
  if (filters.days != null) qs.set("days", String(filters.days));
  if (filters.startDate) qs.set("start_date", filters.startDate);
  if (filters.endDate) qs.set("end_date", filters.endDate);
  if (filters.variant) qs.set("variant", filters.variant);
  if (filters.condition) qs.set("condition", filters.condition);
  if (filters.company) qs.set("company", filters.company);
  if (filters.grade) qs.set("grade", filters.grade);
  if (filters.pageSize != null) qs.set("page_size", String(filters.pageSize));
  const query = qs.toString();
  const url =
    `${SCRYDEX_BASE_URL}/${slug}/v1/cards/${encodeURIComponent(id)}/price_history` +
    (query ? `?${query}` : "");
  try {
    const res = await fetch(url, { headers: scrydexHeaders() });
    if (!res.ok) {
      console.warn(`[scrydex] price_history ${id} HTTP ${res.status}`);
      return null;
    }
    const parsed = PriceHistoryResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`[scrydex] price_history ${id} parse failed: ${parsed.error.issues[0]?.message}`);
      return null;
    }
    return parsed.data.data;
  } catch (err) {
    console.warn(`[scrydex] price_history ${id} error:`, err);
    return null;
  }
}

// --- Sold listings (documented endpoint) -----------------------------------

/**
 * A Scrydex SOLD listing (docs/SCRYDEX_AUDIT.md →
 * https://scrydex.com/docs/pokemon/listings). These are real SOLD records
 * (each carries `sold_at`), the source for the card-detail "Recent Sales"
 * section — NOT active listings. Zod-validated at the boundary.
 */
const ScrydexListingSchema = z.object({
  id: z.string().nullish(),
  source: z.string().nullish(), // e.g. "ebay"
  title: z.string().nullish(),
  variant: z.string().nullish(),
  company: z.string().nullish(),
  grade: z.string().nullish(),
  url: z.string().nullish(),
  price: z.number().nullish(),
  currency: z.string().nullish(),
  sold_at: z.string().nullish(),
});
const ScrydexListingsResponseSchema = z.object({
  data: z.array(ScrydexListingSchema).default([]),
  total_count: z.number().nullish(),
});
export type ScrydexSoldListing = z.infer<typeof ScrydexListingSchema>;

export interface ScrydexListingFilters {
  days?: number;
  source?: string; // e.g. "ebay"
  variant?: string;
  grade?: string;
  company?: string;
  condition?: string;
  pageSize?: number;
}

/**
 * Fetch REAL SOLD listings for a card from the documented endpoint
 * `GET /{slug}/v1/cards/{id}/listings` (1 credit — Audit). `id` MUST be the
 * Scrydex-returned card id. Server-side only. Returns the validated sold
 * records (possibly empty = honest "no recent sales"), or null on failure so
 * the caller degrades to the empty state and NEVER falls back to active
 * listings or fabricates sales.
 *
 * CREDIT SAFETY: live metered call — the caller must pass the owner
 * credit-approval gate before invoking this.
 */
export async function fetchScrydexSoldListings(
  id: string,
  game: Game,
  filters: ScrydexListingFilters = {}
): Promise<ScrydexSoldListing[] | null> {
  const slug = gameSlug(game);
  const qs = new URLSearchParams();
  if (filters.days != null) qs.set("days", String(filters.days));
  if (filters.source) qs.set("source", filters.source);
  if (filters.variant) qs.set("variant", filters.variant);
  if (filters.grade) qs.set("grade", filters.grade);
  if (filters.company) qs.set("company", filters.company);
  if (filters.condition) qs.set("condition", filters.condition);
  if (filters.pageSize != null) qs.set("page_size", String(filters.pageSize));
  const query = qs.toString();
  const url =
    `${SCRYDEX_BASE_URL}/${slug}/v1/cards/${encodeURIComponent(id)}/listings` +
    (query ? `?${query}` : "");
  try {
    const res = await fetch(url, { headers: scrydexHeaders() });
    if (!res.ok) {
      console.warn(`[scrydex] listings ${id} HTTP ${res.status}`);
      return null;
    }
    const parsed = ScrydexListingsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`[scrydex] listings ${id} parse failed: ${parsed.error.issues[0]?.message}`);
      return null;
    }
    // Only genuine SOLD records (have sold_at). Never surface active listings.
    return parsed.data.data.filter((l) => !!l.sold_at);
  } catch (err) {
    console.warn(`[scrydex] listings ${id} error:`, err);
    return null;
  }
}

// --- Population report (include=pop_reports) --------------------------------

// Scrydex pop_reports (docs/SCRYDEX_AUDIT.md Area 4b). Public coverage is PSA
// English only; BGS is UNSUPPORTED and never read as data.
// SHAPE VERIFIED (GET /pokemon/v1/cards/me55c-4?include=prices,pop_reports):
// pop_reports is NOT a top-level key on `data`. It is NESTED INSIDE EACH
// VARIANT, exactly like prices — i.e. `data.variants[] = [{ name, images,
// marketplaces, pop_reports: [...], prices: [...] }, ...]`. We therefore read
// pop_reports off every variant (mirroring how pickRawPrice/pickGradedPrice
// reach into variants[].prices) and aggregate the PSA-English entries across
// variants. (The previous code read the non-existent `data.pop_reports`, so it
// ALWAYS returned null — this path fix is the whole bug.)
// Each pop_reports entry carries a grading company (PSA), a grade label, and a
// count (and possibly language/total). Shapes are parsed DEFENSIVELY with
// `.nullish()`; Zod drops unknown keys. A wrong shape yields zero PSA-English
// grades → the fetcher warn-logs the VARIANT-level keys it saw (see mapping
// step 2b) so it fails LOUD, not silent. Grade label + count are read verbatim;
// a non-finite/absent count drops that grade (never a fabricated 0). An empty
// variants[].pop_reports (card genuinely has no population — e.g. me55c-4) →
// null → honest empty state, NOT a bug and NOT fabricated.
const GradeCountSchema = z.object({
  grade: z.union([z.string(), z.number()]).nullish(),
  count: z.number().nullish(),
});
const PopReportEntrySchema = z.object({
  company: z.string().nullish(), // expected "PSA" | "BGS" | ...
  language: z.string().nullish(), // expected "English" | ...
  grade: z.union([z.string(), z.number()]).nullish(), // per-entry grade label
  count: z.number().nullish(), // per-entry graded count
  total: z.number().nullish(),
  // Some shapes may nest grades under the entry rather than one entry per grade.
  grades: z.array(GradeCountSchema).nullish(),
  // C3 / MEDIUM-2: ladder totals (assumed shape; .nullish() so absence → null,
  // not a crash — RULE 4). Scrydex may report grade/qualified/half sub-totals.
  grade_total: z.number().nullish(),
  qualified_grade_total: z.number().nullish(),
  half_grade_total: z.number().nullish(),
  // C3 / MEDIUM-2 DEFENSIVE: if half ("8.5") / qualified ("9Q") per-grade
  // counts ship under SEPARATE keys instead of mixed into grades[], capture
  // them too so they are not silently dropped.
  half_grades: z.array(GradeCountSchema).nullish(),
  qualified_grades: z.array(GradeCountSchema).nullish(),
});
// pop_reports lives on EACH VARIANT (verified), alongside prices.
const PopReportVariantSchema = z.object({
  name: z.string().nullish(),
  pop_reports: z.array(PopReportEntrySchema).nullish(),
});
const PopReportCardSchema = z.object({
  variants: z.array(PopReportVariantSchema).default([]),
});
// Response wrapper mirrors fetchScrydexCardById: card object at `.data`.
const PopReportResponseSchema = z.object({ data: PopReportCardSchema });

export interface ScrydexPopulation {
  company: "PSA";
  language: "English";
  total: number;
  // C3 — ladder sub-totals (null when the payload omits them; never fabricated).
  gradeTotal: number | null;
  qualifiedGradeTotal: number | null;
  halfGradeTotal: number | null;
  grades: { grade: string; count: number }[];
}

/**
 * Fetch a card's PSA-English population report via the DOCUMENTED include
 * `GET /{slug}/v1/cards/{scrydexId}?include=pop_reports` (1 credit — Audit).
 *
 * `scrydexId` MUST be the Scrydex-native card id (NOT Card.externalId — the id
 * namespaces differ, Audit L0). Server-only (scrydexHeaders). Public coverage
 * is PSA English ONLY — BGS is never read as data.
 *
 * NEVER THROWS to the caller: any !res.ok / network error / missing creds /
 * parse failure → warn-log + null, so a credit-gated orchestrator degrades to
 * "no data" and never clobbers a prior stored report.
 *
 * SHAPE (verified): pop_reports is nested per VARIANT (data.variants[].
 * pop_reports), NOT at data top level. We aggregate PSA-English grades across
 * all variants. FAIL-LOUD (Finding 4): a 200 that parses to zero PSA-English
 * grades warn-logs the VARIANT-level keys it saw, so a still-wrong per-entry
 * shape gives the right diagnostic next time instead of silently returning
 * null for every card.
 */
export async function fetchScrydexPopulation(
  scrydexId: string,
  game: Game
): Promise<ScrydexPopulation | null> {
  const slug = gameSlug(game);
  try {
    const res = await fetch(
      `${SCRYDEX_BASE_URL}/${slug}/v1/cards/${encodeURIComponent(scrydexId)}?include=pop_reports`,
      { headers: scrydexHeaders() }
    );
    if (!res.ok) {
      console.warn(`[scrydex] population ${scrydexId} HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    const parsed = PopReportResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(`[scrydex] population ${scrydexId} parse failed: ${parsed.error.issues[0]?.message}`);
      return null;
    }

    // Step 1+2: pop_reports is nested per variant (verified). Flatten every
    // variant's pop_reports and keep only PSA-English entries (case-insensitive;
    // a missing language is treated as English — public coverage is English
    // only). BGS (or any non-PSA company) is NEVER included.
    const variants = parsed.data.data.variants;
    const psaEntries = variants
      .flatMap((v) => v.pop_reports ?? [])
      .filter((e) => {
        if ((e.company ?? "").toUpperCase() !== "PSA") return false;
        const lang = (e.language ?? "english").toLowerCase();
        return lang === "english";
      });

    // Step 2b fail-loud diagnostic: no PSA-English entry → warn the VARIANT-level
    // keys, so a still-wrong per-entry shape is diagnosable next time.
    if (psaEntries.length === 0) {
      const rawVariants = ((body?.data as Record<string, unknown>)?.variants ?? []) as Record<
        string,
        unknown
      >[];
      console.warn(
        `[scrydex] population ${scrydexId}: no PSA-English pop_reports; variant keys:`,
        rawVariants.map((v) => Object.keys(v ?? {}))
      );
      return null;
    }

    // Step 3+4: build the grade map. An entry carries EITHER a nested grades[]
    // array OR its own grade+count (one entry per grade). Coerce grade→string;
    // drop grades whose count is not finite (never fabricate a 0). Aggregate
    // across variants/entries, summing counts for repeated grade labels.
    const gradeCounts = new Map<string, number>();
    let declaredTotal = 0;
    let sawDeclaredTotal = false;
    const addGrade = (grade: unknown, count: unknown) => {
      if (grade == null) return;
      if (typeof count !== "number" || !Number.isFinite(count)) return;
      const key = String(grade);
      gradeCounts.set(key, (gradeCounts.get(key) ?? 0) + count);
    };
    // C3: sum each ladder sub-total across PSA-English entries the same way as
    // declaredTotal — a finite number present → add; else leave null (never
    // fabricate a 0 ladder total).
    let gradeTotal: number | null = null;
    let qualifiedGradeTotal: number | null = null;
    let halfGradeTotal: number | null = null;
    const addLadderTotal = (acc: number | null, v: unknown): number | null => {
      if (typeof v !== "number" || !Number.isFinite(v)) return acc;
      return (acc ?? 0) + v;
    };
    for (const entry of psaEntries) {
      if (typeof entry.total === "number" && Number.isFinite(entry.total)) {
        declaredTotal += entry.total;
        sawDeclaredTotal = true;
      }
      gradeTotal = addLadderTotal(gradeTotal, entry.grade_total);
      qualifiedGradeTotal = addLadderTotal(qualifiedGradeTotal, entry.qualified_grade_total);
      halfGradeTotal = addLadderTotal(halfGradeTotal, entry.half_grade_total);
      if (entry.grades && entry.grades.length > 0) {
        for (const g of entry.grades) addGrade(g.grade, g.count);
      } else {
        addGrade(entry.grade, entry.count);
      }
      // C3 DEFENSIVE: flatten nested-separate-key half/qualified grades into the
      // one grades[] map (verbatim labels incl "8.5"/"9Q") so they are never
      // dropped if Scrydex ships them under their own keys.
      if (entry.half_grades) for (const g of entry.half_grades) addGrade(g.grade, g.count);
      if (entry.qualified_grades) for (const g of entry.qualified_grades) addGrade(g.grade, g.count);
    }

    const grades = [...gradeCounts.entries()].map(([grade, count]) => ({ grade, count }));
    const summed = grades.reduce((sum, g) => sum + g.count, 0);
    const total = sawDeclaredTotal ? declaredTotal : summed;

    // Step 5: empty grades AND no real total → null (honest gap, NOT fabricated).
    if (grades.length === 0 && total === 0) return null;

    return {
      company: "PSA",
      language: "English",
      total,
      gradeTotal,
      qualifiedGradeTotal,
      halfGradeTotal,
      grades,
    };
  } catch (err) {
    console.warn(`[scrydex] population ${scrydexId} error:`, err instanceof Error ? err.message : err);
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

// Documented Vision response shape (docs/SCRYDEX_AUDIT.md →
// https://scrydex.com/docs/vision/overview). We validate at the boundary and
// read only the fields we use. `matches[].card.id` is the Scrydex-returned
// catalog id; `score` is the confidence (~0.7–1.3+). graded_details carries the
// slab company/grade when the image is a graded card.
const VisionGradedDetailsSchema = z.object({
  company: z.string().nullish(),
  grade_number: z.string().nullish(),
  cert: z.string().nullish(),
});
const VisionMatchSchema = z.object({
  score: z.number().nullish(),
  variant: z.string().nullish(),
  card: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
});
const VisionResponseSchema = z.object({
  data: z.object({
    analysis: z
      .object({
        type: z.string().nullish(),
        game: z.string().nullish(),
        graded_details: VisionGradedDetailsSchema.nullish(),
      })
      .nullish(),
    matches: z.array(VisionMatchSchema).default([]),
  }),
});

/**
 * FR-2d: Vision identify from a card image via the DOCUMENTED endpoint
 * `POST /vision/v1/cards/identify` (multipart/form-data; JPEG/PNG/WebP; 20MB;
 * 5 credits — docs/SCRYDEX_AUDIT.md). Server-side only (uses scrydexHeaders).
 *
 * Returns ScrydexIdentifyResult where `cardId` is the Scrydex-returned catalog
 * id for the top match (load-bearing: recognize/route.ts reads this field).
 * Returns null on no-match, missing credentials, or any failure so the route
 * degrades to on-device Tesseract and NEVER fabricates a match.
 *
 * CREDIT SAFETY: this is a 5-credit live call. It MUST NOT be invoked unless the
 * caller has (a) confirmed the per-account scan allowance and (b) passed the
 * owner credit-approval gate. This client does not self-gate (it stays a thin
 * client); the recognize route owns both gates.
 *
 * @param image  raw image bytes (Buffer) — the caller validated size + MIME.
 * @param mime   validated MIME type (e.g. "image/jpeg").
 * @param games  optional TCG scope (e.g. ["pokemon"]) for faster/accurate match.
 */
export async function identifyCard(
  image: Buffer,
  mime: string,
  games?: string[]
): Promise<ScrydexIdentifyResult | null> {
  if (!process.env.SCRYDEX_API_KEY || !process.env.SCRYDEX_TEAM_ID) return null;
  try {
    const form = new FormData();
    const ext = mime.split("/")[1] || "jpg";
    form.append(
      "image",
      new Blob([new Uint8Array(image)], { type: mime }),
      `scan.${ext}`
    );
    if (games && games.length) form.append("games", games.join(","));

    const res = await fetch(`${SCRYDEX_BASE_URL}/vision/v1/cards/identify`, {
      method: "POST",
      headers: scrydexHeaders(), // X-Api-Key + X-Team-ID; do NOT set Content-Type (Blob sets the multipart boundary)
      body: form,
    });
    if (!res.ok) {
      console.warn(`[scrydex] vision identify HTTP ${res.status}`);
      return null;
    }
    const parsed = VisionResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`[scrydex] vision parse failed: ${parsed.error.issues[0]?.message}`);
      return null;
    }
    const top = parsed.data.data.matches[0];
    if (!top?.card?.id) return null; // honest no-match
    return {
      cardId: top.card.id,
      confidence: typeof top.score === "number" ? top.score : 0,
      name: top.card.name ?? "",
      setCode: "",
    };
  } catch (err) {
    console.warn("[scrydex] vision identify error:", err instanceof Error ? err.message : err);
    return null;
  }
}

