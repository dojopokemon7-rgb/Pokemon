/**
 * Pure price-history chip + chart-matrix helpers for the card-detail screen
 * (Screen 07, search/[id]/page.tsx). Extracted to a SIBLING module — a Next.js
 * `page.tsx` may only export the framework's allowed symbols (default, metadata,
 * …), so these pure helpers live here and are imported by both the page and the
 * unit test (tests/unit/card-detail-chips-matrix.test.ts). No React, no
 * side-effects — unit-testable in isolation (AGENTS.md rule 11).
 */

import type { AreaChartDatum, AreaChartSeries } from "@/components/AreaChart";

// Per-grade history response shape (GET /api/cards/[id]/history, see FEAT-001).
// graded keys are `${COMPANY}|${grade}` (company uppercased, grade verbatim),
// each series oldest→newest; null-price rows already dropped server-side.
export type HistoryPoint = { date: string; price: number };
export type HistoryResponse = { raw: HistoryPoint[]; graded: Record<string, HistoryPoint[]> };

// A single current-price row as returned by /api/cards/[id]/prices (the new
// company/grade/type columns flow through automatically).
export interface CurrentPriceRow {
  condition?: string | null;
  company?: string | null;
  grade?: string | null;
  type?: string | null;
  priceMarket?: number | null;
  priceLow?: number | null;
}

// A single selectable price-history chip. `company === null` marks the Raw
// chip; graded chips carry the uppercased company + verbatim grade and an
// id of `${COMPANY}|${grade}` matching the history map key.
export type Chip = {
  id: string;
  group: string;
  grade: string;
  company: string | null;
  price: number | null;
  color: string;
};

// Graded-chip color palette — mirrors AreaChart's SERIES_PALETTE so a chip's
// border/text color equals its drawn line color. Design tokens only.
const CHIP_PALETTE = [
  "var(--color-dojo-gold)",
  "var(--color-dojo-jade)",
  "var(--color-dojo-vermilion)",
  "var(--color-dojo-gold)",
  "#D400FF",
  "#2D7FF9",
];
const RAW_CHIP_COLOR = "#9AA0A6";

// Company display order for the price-history chips (PSA first, then the rest
// alphabetically). The old Current-prices table and its GRADED_COMPANY_ORDER
// were deleted (FEAT-002).
const CHIP_COMPANY_ORDER = ["PSA", "CGC", "BGS", "TAG", "SGC"];

// ── Grade sort: numeric descending with half-grades interleaved (10, 9.5, 9,
// 8.5 …) and a qualified grade ("9Q") placed immediately AFTER its numeric peer
// (so 9 then 9Q then 8.5). Non-numeric labels sink to the bottom alphabetically.
export function gradeSortKey(grade: string): [number, number] {
  const qualified = /q$/i.test(grade);
  const numeric = parseFloat(grade.replace(/q$/i, ""));
  if (!Number.isFinite(numeric)) return [-Infinity, 0];
  return [-numeric, qualified ? 1 : 0];
}
export function sortByGradeDesc<T extends { grade: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const [an, aq] = gradeSortKey(a.grade);
    const [bn, bq] = gradeSortKey(b.grade);
    if (an !== bn) return an - bn;
    if (aq !== bq) return aq - bq;
    return a.grade.localeCompare(b.grade);
  });
}

// F-09: format a point's date for the AreaChart x-axis / tooltip, e.g.
// "2026-06-01" → "Jun 2026".
export function fmtChartDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// Numeric price read for a current-price row (priceMarket ?? priceLow ?? null)
// — never a formatted string, so buildChartMatrix can plot/flat-fill it.
function rowPrice(r: CurrentPriceRow): number | null {
  return r.priceMarket ?? r.priceLow ?? null;
}

/**
 * buildChips — derive the dynamic price-history chip groups from the card's
 * REAL current prices. Returns one group per Raw + every grading company
 * present (PSA-first), each with its grade chips sorted desc. Chip prices are
 * read NUMERICALLY (not formatted).
 */
export function buildChips(
  currentPrices: CurrentPriceRow[],
  chipPrice: Record<string, number | null>
): { group: string; chips: Chip[] }[] {
  // Raw chip always first; its price comes from chipPrice["raw"] (live).
  const rawGroup = {
    group: "Raw",
    chips: [
      {
        id: "raw",
        group: "Raw",
        grade: "Raw",
        company: null,
        price: chipPrice["raw"] ?? null,
        color: RAW_CHIP_COLOR,
      } satisfies Chip,
    ],
  };

  // Collect graded rows by company (uppercased), one row per (company, grade).
  const byCompany = new Map<string, Map<string, number | null>>();
  for (const r of currentPrices) {
    if ((r.type ?? "raw") !== "graded") continue;
    const company = (r.company ?? "").toUpperCase();
    const grade = r.grade ?? "";
    if (!company || !grade) continue; // no fabricated chip for a missing key
    if (!byCompany.has(company)) byCompany.set(company, new Map());
    byCompany.get(company)!.set(grade, rowPrice(r));
  }

  // Companies: PSA-first via CHIP_COMPANY_ORDER, then any others sorted.
  const companies = [
    ...CHIP_COMPANY_ORDER.filter((c) => byCompany.has(c)),
    ...[...byCompany.keys()].filter((c) => !CHIP_COMPANY_ORDER.includes(c)).sort(),
  ];

  // Global graded-chip index drives the palette color (so each line is unique).
  let gradedIdx = 0;
  const gradedGroups = companies.map((company) => {
    const grades = byCompany.get(company)!;
    const chips = sortByGradeDesc([...grades.keys()].map((grade) => ({ grade }))).map(({ grade }) => {
      const chip: Chip = {
        id: `${company}|${grade}`,
        group: company,
        grade,
        company,
        price: grades.get(grade) ?? null,
        color: CHIP_PALETTE[gradedIdx % CHIP_PALETTE.length],
      };
      gradedIdx += 1;
      return chip;
    });
    return { group: company, chips };
  });

  return [rawGroup, ...gradedGroups];
}

// Exact-match → carry-forward (last known <= date) → leading-edge back-fill
// (first real price). Guarantees a real number for every union date.
function valueAtDate(points: HistoryPoint[], date: string): number {
  let carried: number | null = null;
  for (const p of points) {
    if (p.date === date) return p.price;
    if (p.date < date) carried = p.price;
  }
  return carried ?? points[0].price;
}

/**
 * buildChartMatrix — assemble the multi-series AreaChart data for the user's
 * selected chips. Each chip plots its OWN stored per-grade history; a chip
 * with <2 windowed points flattens to a two-row marker at its current price,
 * and a chip with no history AND a null price is excluded. The output is a
 * DENSE matrix (a real number for every union date × every drawn series) with
 * >=2 rows per series — AreaChart's shared scale is poisoned by any
 * undefined/NaN (see context.json key_patterns).
 */
export function buildChartMatrix({
  activeChips,
  history,
  chipPrice,
  rangeDays,
}: {
  activeChips: Chip[];
  history: HistoryResponse | undefined;
  chipPrice: Record<string, number | null>;
  rangeDays: number;
}): { data: AreaChartDatum[]; series: AreaChartSeries[] } {
  const raw = history?.raw ?? [];
  const graded = history?.graded ?? {};

  // Resolve + window each chip's own series; decide real vs flat vs excluded.
  type Drawn = { chip: Chip; points: HistoryPoint[] };
  const drawn: Drawn[] = [];
  for (const chip of activeChips) {
    const full = chip.company == null ? raw : graded[chip.id] ?? [];
    // Window by rangeDays measured back from THIS series' own newest point.
    let windowed = full;
    if (full.length > 0 && Number.isFinite(rangeDays)) {
      const newest = new Date(`${full[full.length - 1].date}T00:00:00.000Z`).getTime();
      const cutoff = newest - rangeDays * 86_400_000;
      windowed = full.filter((p) => new Date(`${p.date}T00:00:00.000Z`).getTime() >= cutoff);
    }
    if (windowed.length >= 2) {
      drawn.push({ chip, points: windowed });
      continue;
    }
    // <2 real points → honest flat marker at the chip's current price.
    const flat = chipPrice[chip.id] ?? null;
    if (flat == null) continue; // no history + no price → excluded (no fabrication)
    drawn.push({
      chip,
      points: [
        { date: "flat-0", price: flat },
        { date: "flat-1", price: flat },
      ],
    });
  }

  // All chips excluded → honest single-series flat baseline (no fabricated prices).
  if (drawn.length === 0) {
    return {
      data: [
        { label: "", value: 1 },
        { label: "", value: 1 },
      ],
      series: [],
    };
  }

  // Sorted union of every drawn series' dates. Flat markers use synthetic
  // "flat-*" keys that sort after real ISO dates, which is fine — a flat
  // series carries the same value at every union date anyway.
  const allDates = [...new Set(drawn.flatMap((d) => d.points.map((p) => p.date)))].sort();

  // For each series, carry-forward / leading-edge back-fill so EVERY union date
  // has a real number (no undefined/NaN poisoning the shared scale).
  const data: AreaChartDatum[] = allDates.map((date) => {
    const datum: AreaChartDatum = { label: fmtChartDate(date) };
    for (const { chip, points } of drawn) {
      datum[chip.id] = valueAtDate(points, date);
    }
    return datum;
  });

  const series: AreaChartSeries[] = drawn.map(({ chip }) => ({
    valueKey: chip.id,
    label: chip.grade === "Raw" ? "Raw" : chip.grade,
    color: chip.color,
  }));

  return { data, series };
}
