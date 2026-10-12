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
  pickVariantImages,
  pickImageEntry,
  pickRawPrice,
  type ScrydexCard,
} from "../src/lib/services/scrydex.service";
import {
  assertScrydexCreditsApproved,
  estimateCredits,
} from "../src/lib/services/scrydex-credit-gate";
import { deriveStoredCardNumber } from "../src/lib/utils/card-number";
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

type VariantImageMap = Record<string, { small?: string; medium?: string; large?: string }>;

export interface MappedOnePieceCard {
  externalId: string; // Bandai code = Scrydex card id (RULE 3)
  setName: string; // from card.expansion?.name
  setExternalId: string; // onePieceSetExternalId(setName) → "onepiece-<slug>"
  name: string;
  number: string; // deriveStoredCardNumber(id, true) = full Bandai code
  rarity: string | null;
  types: string[];
  imageUrl: string | null; // base art: large ?? medium ?? small ?? null
  marketPrice: number | null;
  variantImages: VariantImageMap;
}

/**
 * First non-empty of the base card's large/medium/small image URLs. Real
 * Scrydex shape: card.images is an ARRAY — read the front entry (pickImageEntry).
 */
function pickBaseImageUrl(card: ScrydexCard): string | null {
  const img = pickImageEntry(card.images);
  if (!img) return null;
  if (typeof img.large === "string" && img.large) return img.large;
  if (typeof img.medium === "string" && img.medium) return img.medium;
  if (typeof img.small === "string" && img.small) return img.small;
  return null;
}

/**
 * Map one Scrydex catalog card → the One Piece upsert shape, validating through
 * `NormalizedCardSchema` (RULE 4) before accepting. Returns `null` for a card
 * that cannot be honestly stored — no set name, or a shape that fails the
 * normalized validator (e.g. empty name, or an `imageUrl` that is neither an
 * absolute URL nor a `/`-rooted path, i.e. an imageless card). A `null` is a
 * DROP (RULE 2), never a fabricated placeholder.
 */
export function mapScrydexCatalogCard(card: ScrydexCard): MappedOnePieceCard | null {
  const externalId = card.id;
  const setName = (card.expansion?.name ?? "").trim();
  if (!setName) return null; // no set → skip (mirrors the seed's set-less skip)

  const number = deriveStoredCardNumber(externalId, true); // full Bandai code
  const imageUrl = pickBaseImageUrl(card);
  const rawName = (card.name ?? "").trim();
  const raw = pickRawPrice(card);
  const marketPrice = raw?.market ?? null; // never fabricated (RULE 2)
  const variantImages = pickVariantImages(card);

  // Re-validate the stored shape at the boundary. imageUrl null → "" fails the
  // schema's absolute-or-rooted refinement, so an imageless One Piece card is
  // DROPPED (matches buildCards drop-invalid).
  const parsed = NormalizedCardSchema.safeParse({
    id: externalId,
    name: rawName,
    number,
    setImage: setName,
    rarity: card.rarity ?? "Unknown",
    hp: card.hp != null ? String(card.hp) : null,
    types: card.types ?? [],
    imageUrl: imageUrl ?? "",
    marketPrice,
  });
  if (!parsed.success) {
    console.warn(
      `[ingest-op] drop ${externalId}: ${parsed.error.issues[0]?.message ?? "invalid"}`
    );
    return null;
  }

  return {
    externalId,
    setName,
    setExternalId: onePieceSetExternalId(setName),
    name: parsed.data.name,
    number,
    rarity: card.rarity ?? null,
    types: card.types ?? [],
    imageUrl,
    marketPrice,
    variantImages,
  };
}

// --- Idempotent upsert ------------------------------------------------------

export interface IngestReport {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
}

/** Canonical, key-sorted JSON of a variant-images map; {} and null both → "". */
function canonical(map: unknown): string {
  if (map == null || typeof map !== "object") return "";
  const obj = map as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "";
  const norm: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      const io: Record<string, unknown> = {};
      for (const key of Object.keys(inner).sort()) io[key] = inner[key];
      norm[k] = io;
    } else {
      norm[k] = v;
    }
  }
  return JSON.stringify(norm);
}

/** Shallow string-array equality for `types`. */
function sameTypes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Upsert the card's parent One Piece set then the card itself, keyed by
 * `externalId`. `game: ONE_PIECE` is set EXPLICITLY on BOTH create and update
 * (the default is POKEMON). `variantImages` is written only when non-empty so a
 * prior backfilled map is never clobbered with `{}`. Returns which happened so
 * the caller can report created/updated/skipped.
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
      rarity: true,
      types: true,
      imageUrl: true,
      marketPrice: true,
      variantImages: true,
      setId: true,
    },
  });

  const hasVariantImages = Object.keys(m.variantImages).length > 0;
  const base = {
    game: Game.ONE_PIECE, // explicit on BOTH branches (default is POKEMON)
    name: m.name,
    number: m.number,
    rarity: m.rarity,
    types: m.types,
    imageUrl: m.imageUrl,
    setId: cardSet.id,
    ...(m.marketPrice != null ? { marketPrice: m.marketPrice } : {}),
    ...(hasVariantImages ? { variantImages: m.variantImages } : {}),
  };

  if (prior == null) {
    await prisma.card.create({ data: { externalId: m.externalId, ...base } });
    return "created";
  }

  const unchanged =
    prior.name === m.name &&
    prior.number === m.number &&
    prior.rarity === m.rarity &&
    sameTypes(prior.types, m.types) &&
    prior.imageUrl === m.imageUrl &&
    (m.marketPrice == null || prior.marketPrice === m.marketPrice) &&
    prior.setId === cardSet.id &&
    (!hasVariantImages || canonical(prior.variantImages) === canonical(m.variantImages));

  if (unchanged) return "skipped";

  await prisma.card.update({ where: { externalId: m.externalId }, data: base });
  return "updated";
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
      const m = mapScrydexCatalogCard(card);
      if (m == null) {
        report.invalid++;
        continue;
      }
      try {
        report[await upsertOnePieceCard(m)]++;
      } catch (err) {
        report.invalid++;
        console.warn(`[ingest-op] upsert ${m.externalId} failed:`, err instanceof Error ? err.message : err);
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
