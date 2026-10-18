/**
 * OWNER-RUN — writes to the configured DATABASE_URL (the Mumbai DB) + makes
 * LIVE, credit-consuming Scrydex catalog calls; NEVER run by agents and NEVER
 * in build/verify.
 *
 * Ingests the ENTIRE Scrydex One Piece catalog (all cards + every variant's
 * images) via the paged list endpoint, so the catalog is complete and the
 * scanner can match any One Piece card. This SUPERSEDES the thin ~45-query
 * name-seed for One Piece (`prisma/seed.ts onePieceQueries`), which only ever
 * populated a few hundred cards and missed alt-art variant images.
 *
 * SCOPE: One Piece ONLY. Pokémon catalog, seed, and ingest paths are untouched.
 * Every write lands in a `onepiece-<slug>` set and sets `game: ONE_PIECE`
 * explicitly (the default is POKEMON and no existing OP write path sets it, so
 * ingested rows are correctly tagged — see requirements §Discrepancy).
 *
 * CREDIT GATING (load-bearing): paging the catalog costs ~1 credit per PAGE
 * (ceil(total_count / 100) ≈ 29 for ~2840 cards). BEFORE any live call this
 * script calls `assertScrydexCreditsApproved("standard", pageCount)` from
 * `@/lib/services/scrydex-credit-gate` (DENY by default — approve via
 * SCRYDEX_LIVE_CREDITS_APPROVED=true or the admin Redis flag). DRY RUN (default)
 * makes exactly ONE gated page-1 fetch to read total_count + print a 5-card
 * sample + the credit estimate — and NO writes.
 *
 * IDEMPOTENT: per-card upsert keyed by `externalId` (the Bandai code, e.g.
 * OP08-023). A second run of the same catalog yields all `skipped` (every mapped
 * field compared to the stored row, incl. a canonical variant-images equality).
 *
 * Usage (PowerShell — the repo path contains a space, always quote it):
 *   cd "d:\Pokemon\Pokemon\.worktrees\op-ingest"
 *   npx tsx scripts/ingest-onepiece-catalog.ts            # DRY RUN: total_count + 5-card sample + credit estimate, 1 gated fetch, NO writes
 *   # After owner approval + SCRYDEX_LIVE_CREDITS_APPROVED=true:
 *   npx tsx scripts/ingest-onepiece-catalog.ts --apply    # full paged ingest + upserts
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Game } from "@prisma/client";
import { prisma } from "../src/lib/db";
import {
  fetchScrydexCatalogPage,
  pickImageEntry,
  type ScrydexCard,
} from "../src/lib/services/scrydex.service";
import { DataSource } from "@prisma/client";
import {
  assertScrydexCreditsApproved,
  estimateCredits,
} from "../src/lib/services/scrydex-credit-gate";
import {
  deriveStoredCardNumber,
  baseVariantName,
  printingExternalId,
} from "../src/lib/utils/card-number";
import { onePieceSetExternalId } from "../src/lib/utils/set-key";
import { NormalizedCardSchema } from "../src/lib/validators/card.validator";

const APPLY = process.argv.slice(2).includes("--apply");
const PAGE_SIZE = 100;
/** Small inter-page delay — polite to upstream (same 250ms the seed uses). */
const REQUEST_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Pure mapper (the testable seam) ---------------------------------------

/** A single CurrentPrice row for one printing (this variant's prices[]). */
export interface MappedOnePiecePrice {
  source: DataSource;
  currency: string;
  variant: string;
  condition: string;
  company: string | null;
  grade: string | null;
  type: "raw" | "graded";
  priceMarket: number | null;
  priceLow: number | null;
}

export interface MappedOnePieceCard {
  externalId: string; // composite per-printing key: baseId or `${baseId}::${name}`
  baseId: string; // the Bandai code = Scrydex card id (RULE 3)
  setName: string; // from card.expansion?.name
  setExternalId: string; // onePieceSetExternalId(setName) → "onepiece-<slug>"
  name: string;
  number: string; // deriveStoredCardNumber(id, true) = full Bandai code (unchanged)
  printing: string; // verbatim variant.name (|| "normal")
  rarity: string | null;
  types: string[];
  imageUrl: string | null; // this variant's art else base art
  marketPrice: number | null; // this variant's NM-raw headline (never fabricated)
  prices: MappedOnePiecePrice[]; // this variant's price rows only
}

/**
 * First non-empty of a Scrydex `images` array's large/medium/small URLs. Real
 * Scrydex shape: images is an ARRAY — read the front entry (pickImageEntry).
 */
function pickImageUrl(images: ScrydexCard["images"]): string | null {
  const img = pickImageEntry(images);
  if (!img) return null;
  if (typeof img.large === "string" && img.large) return img.large;
  if (typeof img.medium === "string" && img.medium) return img.medium;
  if (typeof img.small === "string" && img.small) return img.small;
  return null;
}

/** First non-empty base-card image URL (fallback art for imageless variants). */
function pickBaseImageUrl(card: ScrydexCard): string | null {
  return pickImageUrl(card.images);
}

/** This variant's headline NM-raw market price (never variant-0 / never union). */
function variantHeadlinePrice(
  prices: ScrydexCard["variants"][number]["prices"]
): number | null {
  const nmRaw = prices.find(
    (p) => (p.type ?? "raw") === "raw" && (p.condition ?? "NM") === "NM"
  );
  return nmRaw?.market ?? null; // never fabricated (RULE 2)
}

/** Deduped CurrentPrice rows scoped to ONE variant's prices[]. */
function variantPriceRows(
  variantName: string,
  prices: ScrydexCard["variants"][number]["prices"]
): MappedOnePiecePrice[] {
  const rows = prices
    .filter((p) => p.market != null || p.low != null)
    .map((p) => ({
      source: DataSource.SCRYDEX,
      currency: p.currency ?? "USD",
      variant: variantName,
      condition: p.condition ?? "NM",
      company: p.company ?? null,
      grade: p.grade ?? null,
      type: ((p.type ?? "raw") === "raw" ? "raw" : "graded") as "raw" | "graded",
      priceMarket: p.market ?? null,
      priceLow: p.low ?? null,
    }));
  const seen = new Map<string, MappedOnePiecePrice>();
  for (const r of rows) {
    const k = `${r.currency}|${r.variant}|${r.condition}|${r.company}|${r.grade}|${r.type}`;
    const prev = seen.get(k);
    if (!prev || (r.priceMarket ?? 0) > (prev.priceMarket ?? 0)) seen.set(k, r);
  }
  return [...seen.values()];
}

/**
 * Map one Scrydex catalog card → ONE row per `variants[]` entry (per-printing
 * re-model). Each row gets a composite externalId (base printing keeps the bare
 * Bandai code; non-base = `${baseId}::${variantName}`), its own printing label,
 * its own art (variant art else base card art), and its own price rows. Each row
 * is re-validated through `NormalizedCardSchema` (RULE 4); a row that cannot be
 * honestly stored (no set name, empty name, or no usable image — neither variant
 * nor base art) is DROPPED (RULE 2), never fabricated. Returns the surviving
 * rows (possibly empty).
 */
export function mapScrydexCatalogCard(card: ScrydexCard): MappedOnePieceCard[] {
  const baseId = card.id;
  const setName = (card.expansion?.name ?? "").trim();
  if (!setName) return []; // no set → skip (mirrors the seed's set-less skip)

  const number = deriveStoredCardNumber(baseId, true); // full Bandai code (unchanged)
  const setExternalId = onePieceSetExternalId(setName);
  const rawName = (card.name ?? "").trim();
  const rarity = card.rarity ?? null;
  const types = card.types ?? [];
  const baseArt = pickBaseImageUrl(card);
  const base = baseVariantName(card.variants.map((v) => v.name || "normal"));

  const out: MappedOnePieceCard[] = [];
  for (const variant of card.variants) {
    const printing = variant.name || "normal";
    const externalId = printingExternalId(baseId, printing, base);
    const imageUrl = pickImageUrl(variant.images) ?? baseArt;
    const marketPrice = variantHeadlinePrice(variant.prices);

    // Re-validate the stored shape at the boundary. imageUrl null → "" fails the
    // schema's absolute-or-rooted refinement, so a printing with no variant art
    // AND no base art is DROPPED (MEDIUM-1: fall back to base art first).
    const parsed = NormalizedCardSchema.safeParse({
      id: externalId,
      name: rawName,
      number,
      setImage: setName,
      rarity: card.rarity ?? "Unknown",
      hp: card.hp != null ? String(card.hp) : null,
      types,
      imageUrl: imageUrl ?? "",
      marketPrice,
    });
    if (!parsed.success) {
      console.warn(
        `[ingest-op] drop ${externalId}: ${parsed.error.issues[0]?.message ?? "invalid"}`
      );
      continue;
    }

    out.push({
      externalId,
      baseId,
      setName,
      setExternalId,
      name: parsed.data.name,
      number,
      printing,
      rarity,
      types,
      imageUrl,
      marketPrice,
      prices: variantPriceRows(printing, variant.prices),
    });
  }
  return out;
}

// --- Idempotent upsert ------------------------------------------------------

export interface IngestReport {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
}

/** Shallow string-array equality for `types`. */
function sameTypes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Upsert the card's parent One Piece set then ONE printing row, keyed by the
 * composite `externalId` (per-printing re-model). `game: ONE_PIECE` is set
 * EXPLICITLY on BOTH create and update (the default is POKEMON). After the card
 * row lands we upsert THIS printing's CurrentPrice rows on the existing
 * `@@unique([cardId,source,currency,variant,condition,company,grade,type])`
 * tuple (this variant only). Idempotency rides the printing-aware unchanged
 * check (`prior.printing === m.printing`). Returns which happened so the caller
 * can report created/updated/skipped.
 */
export async function upsertOnePieceCard(
  m: MappedOnePieceCard
): Promise<"created" | "updated" | "skipped"> {
  const cardSet = await prisma.cardSet.upsert({
    where: { externalId: m.setExternalId },
    update: { name: m.setName },
    create: { externalId: m.setExternalId, name: m.setName },
  });

  const prior = await prisma.card.findUnique({
    where: { externalId: m.externalId },
    select: {
      id: true,
      name: true,
      number: true,
      printing: true,
      rarity: true,
      types: true,
      imageUrl: true,
      marketPrice: true,
      setId: true,
    },
  });

  const base = {
    game: Game.ONE_PIECE, // explicit on BOTH branches (default is POKEMON)
    name: m.name,
    number: m.number,
    printing: m.printing,
    rarity: m.rarity,
    types: m.types,
    imageUrl: m.imageUrl,
    setId: cardSet.id,
    ...(m.marketPrice != null ? { marketPrice: m.marketPrice } : {}),
  };

  let outcome: "created" | "updated" | "skipped";
  let cardId: string;

  if (prior == null) {
    const created = await prisma.card.create({
      data: { externalId: m.externalId, ...base },
      select: { id: true },
    });
    cardId = created.id;
    outcome = "created";
  } else {
    cardId = prior.id;
    const unchanged =
      prior.name === m.name &&
      prior.number === m.number &&
      prior.printing === m.printing &&
      prior.rarity === m.rarity &&
      sameTypes(prior.types, m.types) &&
      prior.imageUrl === m.imageUrl &&
      (m.marketPrice == null || prior.marketPrice === m.marketPrice) &&
      prior.setId === cardSet.id;

    if (unchanged) {
      outcome = "skipped";
    } else {
      await prisma.card.update({ where: { externalId: m.externalId }, data: base });
      outcome = "updated";
    }
  }

  // Write THIS printing's price rows (this variant only). An upsert on the
  // 8-column unique tuple is impossible for raw rows (null company/grade can't
  // be matched through the generated compound-key input — see
  // scrydex-pricing.service.ts C1), so we REPLACE this printing's SCRYDEX set:
  // delete its existing SCRYDEX CurrentPrice rows (source-scoped — never touches
  // non-Scrydex rows) then createMany the fresh set. Idempotent: a re-run writes
  // the same set. skipDuplicates guards the delete→create race.
  if (m.prices.length > 0) {
    await prisma.$transaction([
      prisma.currentPrice.deleteMany({
        where: { cardId, source: DataSource.SCRYDEX, variant: m.printing },
      }),
      prisma.currentPrice.createMany({
        data: m.prices.map((p) => ({ cardId, ...p })),
        skipDuplicates: true,
      }),
    ]);
  }

  return outcome;
}

// --- Runner -----------------------------------------------------------------

async function run(): Promise<void> {
  if (!APPLY) {
    // DRY RUN: one gated page-1 fetch (a live credit-consuming call), then
    // print total_count + 5-card sample + credit estimate. NO writes.
    await assertScrydexCreditsApproved("standard", 1);
    const page = await fetchScrydexCatalogPage(Game.ONE_PIECE, 1, PAGE_SIZE);
    if (!page) {
      console.warn("[ingest-op] DRY RUN: page-1 fetch failed (no data). Nothing to estimate.");
      return;
    }
    const total = page.totalCount ?? 0;
    const pages = Math.ceil(total / PAGE_SIZE);
    console.log("[ingest-op] DRY RUN (no --apply) — NO writes.");
    console.log(`[ingest-op] total_count=${total} pageSize=${page.pageSize ?? PAGE_SIZE}`);
    console.log("[ingest-op] sample (first 5):");
    for (const c of page.cards.slice(0, 5)) {
      console.log(`  ${c.id}  ${c.name}  [${c.expansion?.name ?? "(no set)"}]`);
    }
    console.log(
      `[ingest-op] would fetch ${pages} page(s) ≈ ${estimateCredits("standard", pages)} credit(s) ` +
        `(1 credit/page; ~${total} cards). Re-run with --apply (owner-approved) to ingest.`
    );
    return;
  }

  // APPLY: fetch page 1 to read total_count, derive the max-pages cap, gate the
  // full spend, then page the catalog and upsert each card.
  const first = await fetchScrydexCatalogPage(Game.ONE_PIECE, 1, PAGE_SIZE);
  if (!first) {
    console.warn("[ingest-op] APPLY: page-1 fetch failed (no data). Aborting.");
    return;
  }
  const total = first.totalCount ?? first.cards.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); // max-pages cap (no infinite loop)
  console.log(
    `[ingest-op] APPLY — total_count=${total}, will fetch up to ${pages} page(s) ` +
      `≈ ${estimateCredits("standard", pages)} credit(s).`
  );

  // Hard credit gate FIRST — throws ScrydexCreditsNotApproved if denied.
  await assertScrydexCreditsApproved("standard", pages);

  const report: IngestReport = { created: 0, updated: 0, skipped: 0, invalid: 0 };
  let fetched = 0;

  for (let p = 1; p <= pages; p++) {
    const page = p === 1 ? first : await fetchScrydexCatalogPage(Game.ONE_PIECE, p, PAGE_SIZE);
    if (!page || page.cards.length === 0) {
      console.warn(`[ingest-op] page ${p} empty/failed — stopping.`);
      break;
    }
    for (const card of page.cards) {
      fetched++;
      const rows = mapScrydexCatalogCard(card);
      if (rows.length === 0) {
        // Every variant dropped (no set / no honest row) — count one invalid.
        report.invalid++;
        continue;
      }
      for (const m of rows) {
        try {
          report[await upsertOnePieceCard(m)]++;
        } catch (err) {
          report.invalid++;
          console.warn(`[ingest-op] upsert ${m.externalId} failed:`, err instanceof Error ? err.message : err);
        }
      }
    }
    if (fetched >= total) break; // stop once the full catalog is in
    if (p < pages) await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `[ingest-op] done. created=${report.created} updated=${report.updated} ` +
      `skipped=${report.skipped} invalid=${report.invalid} (fetched=${fetched})`
  );
}

// Run only when invoked directly (`tsx scripts/ingest-onepiece-catalog.ts`),
// NOT on import — so the test can import the pure/upsert functions without
// triggering a live, credit-consuming path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
