/**
 * READ-ONLY audit: do list / trending / details derive the same RAW price?
 *
 * Usage: npx tsx scripts/audit-price-consistency.ts
 *
 * STRICTLY READ-ONLY: only prisma findMany reads. No writes, no Scrydex call,
 * and DATABASE_URL is never printed. Compares the OLD derivations (which could
 * surface legacy graded rows that carry condition "NM") against the NEW shared
 * pickHeadlineRaw (src/lib/utils/raw-price.ts). Old "details" depends on the
 * unspecified DB row order, so counts are indicative (rows read in cardId,id order).
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { pickHeadlineRaw, pickBestRaw, isRawRow, rowPrice, type PriceRowLike } from "../src/lib/utils/raw-price";

type Row = PriceRowLike & { cardId: string };
const SAMPLE = 25;
const same = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) < 0.005);

const buckets: Record<string, string[]> = {
  listVsDetailsOld: [], listVsDetailsNew: [], oldDetailGraded: [], oldSearchGraded: [],
  noRawNmButOtherRaw: [], noRawAtAll: [], rawNmOver15xPsa10: [], multiVariant: [],
};
const counts: Record<string, number> = Object.fromEntries(Object.keys(buckets).map((k) => [k, 0]));
const hit = (k: string, ext: string) => { counts[k]++; if (buckets[k].length < SAMPLE) buckets[k].push(ext); };

function auditCard(ext: string, marketPrice: number | null, rows: Row[]) {
  // OLD details: find(raw&&NM) || find(NM) || first row.
  const oldRow =
    rows.find((p) => (p.type ?? "raw") === "raw" && p.condition === "NM") ||
    rows.find((p) => p.condition === "NM") || rows[0];
  const oldDetail = oldRow ? rowPrice(oldRow) : null;
  // OLD search: variant normal + NM (no type filter), take 1; then Card.marketPrice.
  const oldSearchRow = rows.find((p) => p.variant === "normal" && p.condition === "NM");
  const oldSearch = (oldSearchRow ? oldSearchRow.priceMarket ?? null : null) ?? marketPrice;
  // The page falls back to the tile-passed ?price= (the list value) when detail has none.
  if (!same(oldDetail ?? oldSearch, oldSearch)) hit("listVsDetailsOld", ext);
  if (oldRow && !isRawRow(oldRow)) hit("oldDetailGraded", ext);
  if (oldSearchRow && !isRawRow(oldSearchRow)) hit("oldSearchGraded", ext);

  const rawRows = rows.filter(isRawRow);
  const newDetail = pickHeadlineRaw(rows);
  const newList = pickHeadlineRaw(rawRows) ?? marketPrice;
  if (!same(newDetail ?? newList, newList)) hit("listVsDetailsNew", ext);

  if (!rawRows.some((r) => r.condition === "NM" && rowPrice(r) != null)) {
    if (rawRows.some((r) => rowPrice(r) != null)) hit("noRawNmButOtherRaw", ext);
    else hit("noRawAtAll", ext);
  }
  const variants = new Set(rows.map((r) => r.variant ?? "normal"));
  if (variants.size > 1) hit("multiVariant", ext);
  for (const v of variants) {
    const nm = pickBestRaw(rows, v);
    const psa10 = rows.find((r) => r.variant === v && r.type === "graded" && r.company === "PSA" && r.grade === "10");
    if (nm && nm.condition === "NM" && psa10?.priceMarket != null && nm.price > 1.5 * psa10.priceMarket) {
      hit("rawNmOver15xPsa10", ext);
      break;
    }
  }
}

async function main() {
  const cards = await prisma.card.findMany({ select: { id: true, externalId: true, marketPrice: true } });
  const byId = new Map(cards.map((c) => [c.id, c]));
  let cursor: string | undefined;
  let cur: string | null = null;
  let acc: Row[] = [];
  let priced = 0;
  const flush = () => {
    if (cur == null) return;
    const c = byId.get(cur);
    if (c) { priced++; auditCard(c.externalId, c.marketPrice ?? null, acc); }
    acc = [];
  };
  for (;;) {
    const page = await prisma.currentPrice.findMany({
      take: 50_000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [{ cardId: "asc" }, { id: "asc" }],
      select: { id: true, cardId: true, variant: true, type: true, condition: true, company: true, grade: true, priceMarket: true, priceLow: true },
    });
    if (page.length === 0) break;
    for (const r of page) {
      if (r.cardId !== cur) { flush(); cur = r.cardId; }
      acc.push(r);
    }
    cursor = page[page.length - 1].id;
  }
  flush();

  console.log(`cards total: ${cards.length}; cards with CurrentPrice rows: ${priced}`);
  for (const k of Object.keys(counts)) {
    console.log(`\n${k}: ${counts[k]}`);
    if (buckets[k].length) console.log(`  first ${buckets[k].length}: ${buckets[k].join(", ")}`);
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error("audit failed:", e instanceof Error ? e.message : "unknown error");
  await prisma.$disconnect();
  process.exit(1);
});
