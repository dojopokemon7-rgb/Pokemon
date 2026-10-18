/**
 * FULL CATALOG PULL — page the ENTIRE Scrydex catalog (pokemon + onepiece) at
 * pageSize=100, so each request (1 credit) brings 100 cards WITH prices. Imports
 * Card + CardSet + CurrentPrice (raw + graded). NO population/history/sold here
 * (those are on-view later). Idempotent (upsert on externalId), resumable.
 *
 * PER-PRINTING RE-MODEL: each Scrydex `variants[]` entry becomes its OWN Card
 * row. The base/normal printing keeps the base externalId (`baseId`); every
 * non-base printing gets a `${baseId}::${variantName}` composite key. The pure
 * seams `buildCardRows` / `buildPriceRows` are exported for the owner-run
 * `reingest-per-printing.ts` orchestrator and the unit tests. For Pokémon the
 * `baseId` is resolved by the orchestrator (match-then-upsert: Scrydex card.id
 * ≠ the seeded pokemontcg.io externalId like "base1-4"); when this script runs
 * standalone it uses `c.id` as the baseId (green-field catalog pull).
 *
 * Each page = 1 credit. ~47.5k pokemon + ~2.8k onepiece ≈ ~504 credits total.
 *
 * ENV:
 *   GAMES=pokemon,onepiece   (default both)
 *   SCRYDEX_LANG=            (optional language_code filter, e.g. EN — default: all)
 *   MAX_PAGES=               (optional hard cap for a partial/test run)
 *   START_PAGE=              (resume from a page; default 1, per game)
 *
 * Prints the target DB identity FIRST (avoid the local-vs-Supabase mixup).
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { scrydexHeaders } from "../src/lib/services/scrydex.service";
import { DataSource, Game } from "@prisma/client";
import {
  baseVariantName,
  printingExternalId,
  isOnePieceCode,
  deriveStoredCardNumber,
} from "../src/lib/utils/card-number";

const BASE = "https://api.scrydex.com";
const GAMES = (process.env.GAMES ?? "pokemon,onepiece").split(",").map((s) => s.trim()).filter(Boolean);
// NOTE: use SCRYDEX_LANG, NOT LANG — on many systems LANG is the OS locale
// (e.g. "en_US.UTF-8") and would corrupt the language_code filter.
const LANG = process.env.SCRYDEX_LANG?.trim() || null;
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
const START_PAGE = process.env.START_PAGE ? Number(process.env.START_PAGE) : 1;
const SLEEP_MS = 300; // gentle pacing between pages

type SImage = { type?: string; medium?: string; large?: string };
type SPrice = { condition?: string|null; grade?: string|null; company?: string|null; type?: string|null; low?: number|null; market?: number|null; currency?: string|null; trends?: { days_7?: { price_change?: number|null; percent_change?: number|null }|null }|null };
type SVariant = { name?: string; prices?: SPrice[] | null; images?: SImage[] | null };
type SExp = { id?: string; name?: string; series?: string|null; total?: number|null; printed_total?: number|null; release_date?: string|null; logo?: string|null; symbol?: string|null };
type SCard = { id: string; name: string; number?: string|null; rarity?: string|null; types?: string[]|null; images?: SImage[]; variants?: SVariant[]; expansion?: SExp|null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function parseDate(s?: string|null): Date|null { if (!s) return null; const d = new Date(s.replace(/\//g, "-")); return Number.isNaN(d.getTime()) ? null : d; }

/**
 * The full Card create/update row for ONE printing (one Scrydex variant).
 * `externalId` is the composite per-printing key; `printing` is the variant
 * name; `imageUrl` is the variant's own art with base-card fallback.
 */
export interface PokemonCardRow {
  externalId: string;
  scrydexId: string;
  name: string;
  number: string;
  printing: string;
  rarity: string | null;
  types: string[];
  imageUrl: string | null;
  imageUrlHi: string | null;
  marketPrice: number | null;
  lastPricedAt: Date;
  weeklyChangeAbs: number | null;
  weeklyChangePct: number | null;
  setId: string;
  source: DataSource;
  game: Game;
}

/** Pick the front/first image medium+large off an image array. */
function pickImages(images?: SImage[] | null): { medium: string | null; large: string | null } {
  const img = images?.find((i) => i.type === "front") ?? images?.[0];
  return { medium: img?.medium ?? null, large: img?.large ?? null };
}

/**
 * The base-card art, used as the per-printing fallback when a variant has no own
 * image. Returns null when the card has no usable image at all (so a printing
 * with neither its own art nor base art ends up with a null imageUrl).
 */
export function pickBaseImageUrl(c: SCard): { medium: string | null; large: string | null } | null {
  const img = c.images?.find((i) => i.type === "front") ?? c.images?.[0];
  if (!img) return null;
  return { medium: img.medium ?? null, large: img.large ?? null };
}

/** The headline (NM raw) market price + 7-day trend for a SINGLE variant's prices. */
function variantHeadline(prices?: SPrice[] | null): { market: number | null; abs: number | null; pct: number | null } {
  const list = prices ?? [];
  const raw7 = list.find((p) => (p.type ?? "raw") === "raw")?.trends?.days_7;
  const nmRaw = list.find((p) => (p.type ?? "raw") === "raw" && (p.condition ?? "NM") === "NM");
  return { market: nmRaw?.market ?? null, abs: raw7?.price_change ?? null, pct: raw7?.percent_change ?? null };
}

/**
 * Build ONE PokemonCardRow PER Scrydex variant (per printing). The base printing
 * (per baseVariantName) keeps `baseId` as its externalId; non-base printings get
 * `${baseId}::${variantName}`. `baseId` defaults to `c.id` for a standalone
 * green-field pull; the orchestrator passes a resolved existing externalId.
 */
export function buildCardRows(
  c: SCard,
  setId: string,
  game: Game,
  baseId: string = c.id,
): PokemonCardRow[] {
  const variants = (c.variants && c.variants.length > 0) ? c.variants : [{ name: "normal" }];
  const baseName = baseVariantName(variants.map((v) => v.name || "normal"));
  const baseArt = pickBaseImageUrl(c);
  const isOp = isOnePieceCode(baseId);
  const number = deriveStoredCardNumber(baseId, isOp);

  return variants.map((v) => {
    const printing = v.name || "normal";
    const externalId = printingExternalId(baseId, printing, baseName);
    const vImg = pickImages(v.images);
    const head = variantHeadline(v.prices);
    return {
      externalId,
      scrydexId: c.id,
      name: c.name,
      number,
      printing,
      rarity: c.rarity ?? null,
      types: c.types ?? [],
      imageUrl: vImg.medium ?? baseArt?.medium ?? null,
      imageUrlHi: vImg.large ?? baseArt?.large ?? null,
      marketPrice: head.market,
      lastPricedAt: new Date(),
      weeklyChangeAbs: head.abs,
      weeklyChangePct: head.pct,
      setId,
      source: DataSource.SCRYDEX,
      game,
    };
  });
}

/** A deduped CurrentPrice row shape for one printing. */
export interface PokemonPriceRow {
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
}

/**
 * Build deduped CurrentPrice rows for ONE variant's prices, attached to the
 * given cardId. (Per-printing: the caller passes a single variant, so `variant`
 * is that one printing's name.)
 */
export function buildPriceRows(v: SVariant, cardId: string): PokemonPriceRow[] {
  const variantName = v.name ?? "normal";
  const rows = (v.prices ?? [])
    .filter((p) => p.market != null || p.low != null)
    .map((p) => ({
      cardId,
      source: DataSource.SCRYDEX,
      currency: p.currency ?? "USD",
      variant: variantName,
      condition: p.condition ?? "NM",
      company: p.company ?? null,
      grade: p.grade ?? null,
      type: (p.type ?? "raw") === "raw" ? "raw" : "graded",
      priceMarket: p.market ?? null,
      priceLow: p.low ?? null,
    }));
  const seen = new Map<string, PokemonPriceRow>();
  for (const r of rows) {
    const k = `${r.currency}|${r.variant}|${r.condition}|${r.company}|${r.grade}|${r.type}`;
    const prev = seen.get(k);
    if (!prev || (r.priceMarket ?? 0) > (prev.priceMarket ?? 0)) seen.set(k, r);
  }
  return [...seen.values()];
}

// Per-run set cache so we upsert each set once, not per card.
const setCache = new Map<string, string>(); // setExternalId -> CardSet.id

async function upsertSet(slug: string, exp: SExp): Promise<string | null> {
  if (!exp?.id) return null;
  const extId = `${slug}-${exp.id}`;
  const cached = setCache.get(extId);
  if (cached) return cached;
  const set = await prisma.cardSet.upsert({
    where: { externalId: extId },
    update: { name: exp.name ?? exp.id, series: exp.series ?? null, total: exp.total ?? null, printedTotal: exp.printed_total ?? null, releaseDate: parseDate(exp.release_date), logoUrl: exp.logo ?? null, symbolUrl: exp.symbol ?? null },
    create: { externalId: extId, name: exp.name ?? exp.id, series: exp.series ?? null, total: exp.total ?? null, printedTotal: exp.printed_total ?? null, releaseDate: parseDate(exp.release_date), logoUrl: exp.logo ?? null, symbolUrl: exp.symbol ?? null },
  });
  setCache.set(extId, set.id);
  return set.id;
}

async function pullGame(slug: string, credits: { n: number }) {
  const game = slug === "onepiece" ? Game.ONE_PIECE : Game.POKEMON;
  const langQ = LANG ? `q=language_code:${encodeURIComponent(LANG)}&` : "";
  let page = START_PAGE, cards = 0, priceRows = 0, pagesDone = 0, total = 0;
  console.log(`\n=== ${slug}${LANG ? ` (lang ${LANG})` : ""} ===`);
  for (;;) {
    if (pagesDone >= MAX_PAGES) { console.log(`  MAX_PAGES ${MAX_PAGES} reached`); break; }
    const url = `${BASE}/${slug}/v1/cards?${langQ}pageSize=100&page=${page}&include=prices`;
    let res: Response | null = null;
    let attempt = 0;
    const MAX_ATTEMPTS = 6;
    for (;;) {
      try {
        res = await fetch(url, { headers: scrydexHeaders() });
      } catch {
        res = null;
      }
      if (res && res.ok) break;
      const status = res?.status ?? "network";
      attempt++;
      if (attempt >= MAX_ATTEMPTS) { console.log(`  page ${page}: HTTP ${status} after ${attempt} tries — stopping game`); break; }
      const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1)); // 2s,4s,8s,16s,30s
      console.log(`  page ${page}: HTTP ${status} — retry ${attempt}/${MAX_ATTEMPTS} in ${backoff / 1000}s`);
      await sleep(backoff);
    }
    if (!res || !res.ok) break;
    credits.n++;
    const json = await res.json();
    const data: SCard[] = json.data ?? [];
    total = json.total_count ?? total;
    if (data.length === 0) { console.log(`  page ${page}: empty — done`); break; }
    // Resolve sets for this page (cached), then build ONE row per printing and
    // bulk insert. Fresh catalog → createMany skipDuplicates; a re-run is safe.
    const allCardRows: PokemonCardRow[] = [];
    const cardByExt = new Map<string, SCard>(); // externalId(base) -> card, for price attach
    const variantByExt = new Map<string, SVariant>(); // printing externalId -> its variant
    for (const c of data) {
      if (!c.expansion?.id) continue;
      const setId = await upsertSet(slug, c.expansion);
      if (!setId) continue;
      const rows = buildCardRows(c, setId, game); // baseId defaults to c.id (green-field)
      const variants = (c.variants && c.variants.length > 0) ? c.variants : [{ name: "normal" }];
      rows.forEach((r, i) => {
        allCardRows.push(r);
        variantByExt.set(r.externalId, variants[i]);
      });
      cardByExt.set(c.id, c);
    }
    if (allCardRows.length) {
      await prisma.card.createMany({ data: allCardRows.map(({ printing, ...rest }) => ({ ...rest, printing })), skipDuplicates: true });
      // Read back ids for this page's externalIds to attach prices per printing.
      const ids = await prisma.card.findMany({
        where: { externalId: { in: allCardRows.map((r) => r.externalId) } },
        select: { id: true, externalId: true },
      });
      const idByExt = new Map(ids.map((r) => [r.externalId, r.id]));
      const allPrices = allCardRows.flatMap((r) => {
        const cid = idByExt.get(r.externalId);
        const variant = variantByExt.get(r.externalId);
        return cid && variant ? buildPriceRows(variant, cid) : [];
      });
      if (allPrices.length) {
        await prisma.currentPrice.createMany({ data: allPrices, skipDuplicates: true });
        priceRows += allPrices.length;
      }
      cards += allCardRows.length;
    }
    pagesDone++;
    console.log(`  page ${page}: rows ${cards} | priceRows ${priceRows} | credits ${credits.n}`);
    page++;
    await sleep(SLEEP_MS);
  }
  console.log(`  ${slug} DONE: ${cards} printing rows, ${priceRows} price rows`);
}

async function main() {
  const ident = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`select current_database() as db`);
  console.log("TARGET DB:", ident[0], "| host:", (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":****@"));
  console.log(`games: ${GAMES.join(", ")} | lang: ${LANG ?? "all"} | maxPages: ${MAX_PAGES}`);

  const credits = { n: 0 };
  const t0 = Date.now();
  for (const slug of GAMES) await pullGame(slug, credits);
  console.log(`\n=== ALL DONE — ~${credits.n} credits, ${((Date.now()-t0)/1000).toFixed(0)}s ===`);

  const cardCount = await prisma.card.count();
  const priceCount = await prisma.currentPrice.count();
  console.log(`catalog now: ${cardCount} cards, ${priceCount} price rows`);
  await prisma.$disconnect();
}

// Only run the live pull when executed directly, not when imported by the
// orchestrator / tests.
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
