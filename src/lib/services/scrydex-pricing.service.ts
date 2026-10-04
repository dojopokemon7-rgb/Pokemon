/**
 * Scrydex pricing orchestrator — the SINGLE WRITER for Scrydex-sourced
 * pricing (FR-4, design §3.6). This is the ONLY place that:
 *   - owns the 24h freshness gate (keyed on the newest
 *     SyncLog(job="scrydex_history", cardId).ranAt),
 *   - persists the fresh RAW current point (PricingHistory + CurrentPrice),
 *   - meters credits into SyncLog.
 *
 * Centralising these here is deliberate: all pricing callers go through
 * pullAndStoreScrydexPrice, so the gate, the persistence rule, and the
 * normalization rule cannot drift between callers (bug-fix-the-shared-function
 * discipline). The thin scrydex.service.ts client stays Prisma-free
 * (AGENTS.md §5.11); all DB side effects live here.
 *
 * NEVER fabricate data: a missing real value stays null (UI → "—"); prices
 * are only ever filtered out, never coerced to 0. The old first-pull
 * "scrydex-trend" backfill (which DERIVED prior points from trend deltas) is
 * REMOVED (Req 7.2) — real multi-point history comes from the DOCUMENTED
 * endpoint GET /{slug}/v1/cards/{id}/price_history (fetchScrydexPriceHistory),
 * a live 3-credit call gated behind Owner_Approval, NOT invoked from here.
 */
import { prisma } from "@/lib/db";
import { DataSource, Game } from "@prisma/client";
import {
  fetchScrydexCardById,
  fetchScrydexPriceHistory,
  fetchScrydexPopulation,
  resolveScrydexCard,
  pickRawPrice,
  type ScrydexCard,
} from "./scrydex.service";
import {
  assertScrydexCreditsApproved,
  SCRYDEX_CREDIT_COST,
} from "./scrydex-credit-gate";

// ponytail: global 24h staleness window — the smallest honest cadence that
// keeps credit burn ~1/card/day. Ceiling: a card re-priced <24h ago won't
// refresh even if the market moved intraday. Upgrade path: per-card
// volatility-driven windows.
export const SCRYDEX_STALE_MS = 24 * 60 * 60 * 1000;

// ponytail: provisional — the FR-7 pilot MEASURES real cost; update this
// constant from the pilot's reported burn before any bulk backfill.
export const SCRYDEX_CREDITS_PER_CALL = 1;

const SCRYDEX_HISTORY_JOB = "scrydex_history";
// Distinct job label so population pulls are separable in credit metering and
// do NOT touch the history freshness gate (keyed on job="scrydex_history").
const SCRYDEX_POPULATION_JOB = "scrydex_population";

export interface ScrydexPullCard {
  id: string;
  externalId: string;
  name: string;
  number: string;
  game: Game;
  scrydexId?: string | null;
  setName?: string | null;
  setCode?: string | null;
}

/**
 * Pull a card's live Scrydex price and store it (store-once / reuse / grow).
 *
 * Flow (design §3.6):
 *   1. Freshness gate (unless opts.force): skip entirely when the newest
 *      SyncLog(job="scrydex_history", cardId) ranAt is within SCRYDEX_STALE_MS
 *      — no HTTP, no row. Gated on SyncLog (NOT CurrentPrice) so a graded-only
 *      / no-raw card is still throttled for 24h instead of re-pulled every run.
 *   2. Pull: by cached scrydexId when present, else resolve by name+number+set
 *      and cache the resolved id. null/throw → failed SyncLog, return.
 *   3. Persist the fresh raw point → one PricingHistory (source="scrydex") +
 *      upsert one CurrentPrice (source=SCRYDEX).
 *   4. (Real multi-point history is NOT derived here — it comes from the
 *      documented price_history endpoint under Owner_Approval; see docstring.)
 *   5. Meter: SyncLog(status="ok", credits) on success.
 */
export async function pullAndStoreScrydexPrice(
  card: ScrydexPullCard,
  opts?: { force?: boolean }
): Promise<{ pulled: boolean; credits: number; card: ScrydexCard | null }> {
  // --- 1. Freshness gate ---------------------------------------------------
  // When the gate short-circuits we have NOT fetched a ScrydexCard this call,
  // so we return `card: null`. Callers that need the resolved card on a fresh
  // view (e.g. the graded route) read the STORED graded price instead — the
  // gate exists precisely so a repeat public view costs no credit.
  if (!opts?.force) {
    const last = await prisma.syncLog.findFirst({
      where: { job: SCRYDEX_HISTORY_JOB, cardId: card.id },
      orderBy: { ranAt: "desc" },
      select: { ranAt: true },
    });
    if (last && Date.now() - last.ranAt.getTime() < SCRYDEX_STALE_MS) {
      return { pulled: false, credits: 0, card: null };
    }
  }

  // --- 2. Pull (native-id resolution) --------------------------------------
  let scrydexCard: ScrydexCard | null = null;
  let resolvedId: string | null = card.scrydexId ?? null;
  try {
    if (card.scrydexId) {
      scrydexCard = await fetchScrydexCardById(card.scrydexId, card.game);
    } else {
      const resolved = await resolveScrydexCard({
        name: card.name,
        number: card.number,
        setName: card.setName ?? undefined,
        setCode: card.setCode ?? undefined,
        game: card.game,
      });
      if (resolved) {
        scrydexCard = resolved.card;
        resolvedId = resolved.scrydexId;
      }
    }
  } catch (err) {
    scrydexCard = null;
    console.warn(
      `[scrydex-pricing] pull ${card.externalId} threw:`,
      err instanceof Error ? err.message : err
    );
  }

  if (!scrydexCard) {
    await prisma.syncLog.create({
      data: {
        job: SCRYDEX_HISTORY_JOB,
        cardId: card.id,
        status: "failed",
        credits: 0,
        error: `No Scrydex match for ${card.externalId} (${card.name})`,
      },
    });
    return { pulled: false, credits: 0, card: null };
  }

  // Cache the resolved native id for the next pull (search → by-id path).
  if (resolvedId && resolvedId !== card.scrydexId) {
    try {
      await prisma.card.update({
        where: { id: card.id },
        data: { scrydexId: resolvedId },
      });
    } catch {
      // A unique-collision or missing row must not fail the pull — the id is
      // just a cache; a re-resolve next run is harmless.
    }
  }

  const raw = pickRawPrice(scrydexCard);
  const now = new Date();

  // --- Weekly price change (plan §4) -----------------------------------
  // Persist the REAL 7-day trend delta from the Scrydex payload onto the Card
  // so the search/trending sorts can ORDER BY it. Absolute + percent come
  // straight from trends.days_7 — never fabricated. A missing trend leaves the
  // columns untouched (honest null). Best-effort: must not fail the pull.
  const wk = raw?.trends?.days_7;
  if (wk && (typeof wk.price_change === "number" || typeof wk.percent_change === "number")) {
    try {
      await prisma.card.update({
        where: { id: card.id },
        data: {
          ...(typeof wk.price_change === "number" ? { weeklyChangeAbs: wk.price_change } : {}),
          ...(typeof wk.percent_change === "number" ? { weeklyChangePct: wk.percent_change } : {}),
        },
      });
    } catch (wkErr) {
      console.warn(
        `[scrydex-pricing] weekly-change update failed for ${card.externalId} (non-fatal):`,
        wkErr instanceof Error ? wkErr.message : wkErr
      );
    }
  }

  if (raw) {
    const variant = raw.variant;
    const condition = raw.condition;
    const currency = raw.currency;

    // --- Lazy cost-basis resolution (plan §5) ----------------------------
    // Any owned lot of this card with an UNRESOLVED basis (purchasePrice null,
    // added without a usable price) gets resolved to this freshly-pulled market
    // price. Scoped to lots that are still unresolved + not sold; we never
    // overwrite a user-entered or already-resolved basis. Best-effort: a
    // resolution failure must not fail the price pull.
    if (raw.market != null && raw.market > 0) {
      try {
        await prisma.userCollection.updateMany({
          where: { cardId: card.id, purchasePrice: null, isSold: false },
          data: {
            purchasePrice: raw.market,
            costBasisSource: "scrydex-current",
            costBasisCurrency: currency,
            costBasisAttemptedAt: now,
          },
        });
      } catch (resolveErr) {
        console.warn(
          `[scrydex-pricing] lazy cost-basis resolve failed for ${card.externalId} (non-fatal):`,
          resolveErr instanceof Error ? resolveErr.message : resolveErr
        );
      }
    }

    // --- 3. Persist the fresh RAW current point --------------------------
    await prisma.pricingHistory.createMany({
      data: [
        {
          cardId: card.id,
          priceMarket: raw.market,
          priceLow: raw.low,
          source: "scrydex",
          currency,
          sourceCurrency: currency,
          variant,
          condition,
          recordedAt: now,
        },
      ],
      skipDuplicates: true,
    });

    // --- 4. Real history backfill: the fabricated scrydex-trend derivation
    // is REMOVED (Req 7.2). Real multi-point history comes from the DOCUMENTED
    // endpoint GET /{slug}/v1/cards/{id}/price_history (fetchScrydexPriceHistory),
    // a live 3-credit-per-call request gated behind Owner_Approval (Checkpoint D)
    // and NOT invoked from this writer. Until that pull runs, history is exactly
    // the real points already stored — honest gaps, never fabricated points.
  }

  // C1 — full price capture: persist EVERY variants[].prices[] entry as its own
  // CurrentPrice row (all raw conditions + all graded company/grade). This runs
  // OUTSIDE the `if (raw)` block so a GRADED-ONLY card (no raw NM price) still
  // captures its graded rows (AC-18). It runs after the `if (!scrydexCard)`
  // guard, where variants[] is guaranteed present (HIGH-2); a throttled call
  // returns at the top and captures nothing new (the prior fresh call already
  // stored the full set — AC-24).
  //
  // WHY delete+createMany (not per-entry upsert): raw rows carry company=NULL /
  // grade=NULL, and Prisma cannot target a nullable column through a
  // compound-unique `where` ("Argument company must not be null"), so
  // upsert-on-the-8-column-key is impossible for raw rows. Instead we REPLACE
  // the whole SCRYDEX set for this card: delete the card's existing SCRYDEX
  // CurrentPrice rows (source-scoped — never touches non-Scrydex rows) then
  // createMany the fresh full set. Correctly idempotent because the 24h
  // freshness gate guarantees one COMPLETE fresh set per pull. The two writes
  // run in a $transaction so a mid-way crash can never leave the card with zero
  // prices. Keeps company/grade NULL for raw (RULE 2 — no fabricated sentinel).
  const priceRows: {
    cardId: string;
    source: DataSource;
    currency: string;
    variant: string;
    condition: string;
    company: string | null;
    grade: string | null;
    type: string;
    priceMarket: number | null;
    priceLow: number | null;
  }[] = [];
  for (const v of scrydexCard.variants) {
    for (const p of v.prices) {
      const market = typeof p.market === "number" ? p.market : null;
      const low = typeof p.low === "number" ? p.low : null;
      if (market == null && low == null) continue; // honest skip (AC-22) — never a fabricated $0
      const isGraded = p.type !== "raw";
      // MEDIUM-1: graded `condition` is NOISE for the dedupe identity (a graded
      // row's identity is company+grade+variant). Scrydex often returns
      // condition:null for graded entries. Coerce to a SINGLE STABLE sentinel
      // "GRADED". Raw rows keep their real condition (null → "NM"), which IS
      // part of their identity (NM vs LP vs MP vs HP distinct rows).
      priceRows.push({
        cardId: card.id,
        source: DataSource.SCRYDEX,
        currency: p.currency || "USD",
        variant: v.name || "normal",
        condition: isGraded ? "GRADED" : (p.condition || "NM"),
        company: isGraded ? (p.company ?? "").toUpperCase() || null : null,
        grade: isGraded ? (p.grade ?? null) : null, // verbatim (incl "8.5","9Q")
        type: isGraded ? "graded" : "raw",
        priceMarket: market,
        priceLow: low,
      });
    }
  }
  // Atomic replace of the SCRYDEX price set — only when there is at least one
  // real row (never wipe the stored set to nothing on an all-null payload).
  if (priceRows.length > 0) {
    await prisma.$transaction([
      prisma.currentPrice.deleteMany({
        where: { cardId: card.id, source: DataSource.SCRYDEX },
      }),
      prisma.currentPrice.createMany({ data: priceRows }),
    ]);
  }

  // --- 5. Credit metering --------------------------------------------------
  // One HTTP fetch happened (resolve-search OR by-id), so meter one call
  // regardless of whether a raw price existed.
  await prisma.syncLog.create({
    data: {
      job: SCRYDEX_HISTORY_JOB,
      cardId: card.id,
      status: "ok",
      credits: SCRYDEX_CREDITS_PER_CALL,
    },
  });

  return { pulled: true, credits: SCRYDEX_CREDITS_PER_CALL, card: scrydexCard };
}

/**
 * Pull and persist REAL RAW/Near-Mint price HISTORY from the documented
 * `/price_history` endpoint and store it as real `PricingHistory` points
 * (store-once, honest gaps). This is the replacement for the removed
 * `scrydex-trend` fabrication (Req 7.2).
 *
 * CREDIT-GATED: a history request costs 3 credits (docs/SCRYDEX_AUDIT.md), so
 * this REFUSES unless live-credit spend is owner-approved (see
 * scrydex-credit-gate). Throws `ScrydexCreditsNotApproved` when denied — callers
 * surface that as "pending approval", never silently spend.
 *
 * `scrydexId` MUST be the Scrydex-returned card id. We only persist RAW NM
 * points here (the RAW chart series); GRADED (PSA/BGS) history-series storage
 * is intentionally deferred because the response's company/grade labelling is
 * UNRESOLVED (Audit L2) — we never fabricate graded series. Points are stored
 * with their REAL `date` as recordedAt, `source="scrydex"`, `sourceCurrency`
 * preserved; a null market+low point is skipped (honest gap, never $0).
 */
export async function pullAndStoreScrydexHistory(
  card: { id: string; game: Game; scrydexId: string },
  filters?: { days?: number }
): Promise<{ stored: number; credits: number }> {
  // Hard gate — refuses to spend credits without owner approval.
  await assertScrydexCreditsApproved("priceHistory", 1);

  const days = await fetchScrydexPriceHistory(card.scrydexId, card.game, {
    condition: "NM",
    days: filters?.days,
  });

  // Meter the (approved) call regardless of outcome — one HTTP request happened.
  const credits = SCRYDEX_CREDIT_COST.priceHistory;

  if (!days) {
    await prisma.syncLog.create({
      data: {
        job: SCRYDEX_HISTORY_JOB,
        cardId: card.id,
        status: "failed",
        credits,
        error: "price_history fetch returned null",
      },
    });
    return { stored: 0, credits };
  }

  // Flatten to RAW NM points only; keep real date + source currency.
  const rows: Array<{
    cardId: string;
    priceMarket: number | null;
    priceLow: number | null;
    source: string;
    currency: string;
    sourceCurrency: string;
    variant: string;
    condition: string;
    recordedAt: Date;
  }> = [];
  for (const day of days) {
    const recordedAt = new Date(`${day.date}T00:00:00.000Z`);
    if (Number.isNaN(recordedAt.getTime())) continue; // skip unparseable dates
    for (const p of day.prices) {
      if ((p.type ?? "raw") !== "raw") continue; // RAW series only (see docstring)
      if ((p.condition ?? "NM") !== "NM") continue; // Near Mint only
      const market = typeof p.market === "number" ? p.market : null;
      const low = typeof p.low === "number" ? p.low : null;
      if (market == null && low == null) continue; // honest gap, never $0
      const cur = p.currency || "USD";
      rows.push({
        cardId: card.id,
        priceMarket: market,
        priceLow: low,
        source: "scrydex",
        currency: cur,
        sourceCurrency: cur,
        variant: p.variant || "normal",
        condition: p.condition || "NM",
        recordedAt,
      });
    }
  }

  if (rows.length > 0) {
    await prisma.pricingHistory.createMany({ data: rows, skipDuplicates: true });
  }

  await prisma.syncLog.create({
    data: { job: SCRYDEX_HISTORY_JOB, cardId: card.id, status: "ok", credits },
  });

  return { stored: rows.length, credits };
}

/**
 * Pull a card's PSA-English population report and store it as the one CURRENT
 * PopulationReport row (upsert, store-once / overwrite-in-place).
 *
 * CREDIT-GATED-AT-TOP: a population request costs 1 credit (docs/SCRYDEX_AUDIT.md),
 * so this REFUSES unless live-credit spend is owner-approved — the gate runs
 * FIRST so a denied call performs NO HTTP at all. Throws
 * `ScrydexCreditsNotApproved` when denied; callers surface "pending approval".
 *
 * NOT invoked anywhere this phase: no route/sync/render imports it. It exists
 * and is tested only; a later owner-approved step adds the manual-refresh
 * trigger. WHY `scrydexId` (not `externalId`): the Scrydex id namespace differs
 * from the TCGdex/Bandai externalId, so we resolve + cache the native id.
 * WHY a null fetch stores nothing: we NEVER clobber a prior good report with a
 * transient null — the honest-gap rule.
 *
 * REFRESH-MUST-INVALIDATE-CACHE (follow-up, out of scope this phase): the later
 * manual-refresh trigger MUST, after a successful upsert, invalidate
 * RedisKeys.cardPopulation(externalId) (best-effort, fail-open) so the fresh
 * report is served before the 24h TTL expires.
 */
export async function pullAndStorePopulation(card: {
  id: string;
  game: Game;
  scrydexId?: string | null;
  name: string;
  number: string;
  setName?: string | null;
  setCode?: string | null;
}): Promise<{ stored: boolean; credits: number }> {
  // 1. Credit gate FIRST — throws ScrydexCreditsNotApproved, no HTTP when denied.
  await assertScrydexCreditsApproved("population", 1);

  const credits = SCRYDEX_CREDIT_COST.population;

  // 2. Resolve scrydexId (reuse cached, else search by name+number+set).
  let scrydexId: string | null = card.scrydexId ?? null;
  if (!scrydexId) {
    const resolved = await resolveScrydexCard({
      name: card.name,
      number: card.number,
      setName: card.setName ?? undefined,
      setCode: card.setCode ?? undefined,
      game: card.game,
    });
    if (resolved) {
      scrydexId = resolved.scrydexId;
      // Best-effort cache the resolved id — a unique-collision / missing row
      // must not fail the pull (it is only a cache; a re-resolve is harmless).
      try {
        await prisma.card.update({
          where: { id: card.id },
          data: { scrydexId },
        });
      } catch {
        // swallow — cache-only.
      }
    }
  }

  if (!scrydexId) {
    await prisma.syncLog.create({
      data: {
        job: SCRYDEX_POPULATION_JOB,
        cardId: card.id,
        status: "failed",
        credits,
        error: `No Scrydex match for ${card.id} (${card.name})`,
      },
    });
    return { stored: false, credits };
  }

  // 3. Fetch — null → failed SyncLog, meter the credit, DO NOT clobber a prior
  //    stored report (never overwrite good data with a transient null).
  const population = await fetchScrydexPopulation(scrydexId, card.game);
  if (!population) {
    await prisma.syncLog.create({
      data: {
        job: SCRYDEX_POPULATION_JOB,
        cardId: card.id,
        status: "failed",
        credits,
        error: "population fetch returned null",
      },
    });
    return { stored: false, credits };
  }

  // 4. Upsert the one CURRENT PSA-English report in place.
  // C3: store the WIDENED grades JSON object carrying the ladder sub-totals
  // alongside the per-grade array (incl half "8.5" / qualified "9Q"). The
  // `total` top-level column is unchanged. A legacy bare {grade,count}[] blob
  // from before this change still reads back (reader union — population.service).
  const gradesJson = {
    grades: population.grades,
    gradeTotal: population.gradeTotal,
    qualifiedGradeTotal: population.qualifiedGradeTotal,
    halfGradeTotal: population.halfGradeTotal,
  };
  await prisma.populationReport.upsert({
    where: {
      cardId_source_company_language: {
        cardId: card.id,
        source: "scrydex",
        company: "PSA",
        language: "English",
      },
    },
    update: { grades: gradesJson, total: population.total, refreshedAt: new Date() },
    create: {
      cardId: card.id,
      source: "scrydex",
      company: "PSA",
      language: "English",
      grades: gradesJson,
      total: population.total,
      refreshedAt: new Date(),
    },
  });

  // 5. Meter — distinct job label so the history freshness gate is unaffected.
  await prisma.syncLog.create({
    data: { job: SCRYDEX_POPULATION_JOB, cardId: card.id, status: "ok", credits },
  });

  return { stored: true, credits };
}
