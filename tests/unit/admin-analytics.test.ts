import { describe, it, expect } from "vitest";
import {
  fillDailyRange,
  toCumulative,
  utcDayKey,
  type DailyCount,
} from "@/lib/utils/admin-analytics";

describe("utcDayKey", () => {
  it("formats a Date as a UTC YYYY-MM-DD key", () => {
    expect(utcDayKey(new Date("2024-03-05T23:30:00Z"))).toBe("2024-03-05");
  });
});

describe("fillDailyRange", () => {
  const start = new Date("2024-01-01T00:00:00Z");
  const end = new Date("2024-01-05T00:00:00Z");

  it("densifies sparse rows into a gap-free inclusive range (missing days = 0)", () => {
    const rows: DailyCount[] = [
      { date: "2024-01-01", count: 3 },
      { date: "2024-01-03", count: 5 },
    ];
    const out = fillDailyRange(rows, start, end);
    expect(out.map((d) => d.date)).toEqual([
      "2024-01-01",
      "2024-01-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
    ]);
    expect(out.map((d) => d.count)).toEqual([3, 0, 5, 0, 0]);
  });

  it("sums in-range duplicates and ignores out-of-range days", () => {
    const rows: DailyCount[] = [
      { date: "2024-01-02", count: 2 },
      { date: "2024-01-02", count: 4 },
      { date: "2023-12-31", count: 99 }, // before range → ignored
      { date: "2024-02-01", count: 99 }, // after range → ignored
    ];
    const out = fillDailyRange(rows, start, end);
    expect(out.find((d) => d.date === "2024-01-02")?.count).toBe(6);
    expect(out).toHaveLength(5);
  });

  it("returns a single day when start === end", () => {
    const out = fillDailyRange([{ date: "2024-01-01", count: 7 }], start, start);
    expect(out).toEqual([{ date: "2024-01-01", count: 7 }]);
  });
});

describe("toCumulative", () => {
  it("produces a running total", () => {
    const daily: DailyCount[] = [
      { date: "2024-01-01", count: 2 },
      { date: "2024-01-02", count: 0 },
      { date: "2024-01-03", count: 3 },
    ];
    expect(toCumulative(daily).map((d) => d.count)).toEqual([2, 2, 5]);
  });

  it("seeds the running total with the pre-range baseline", () => {
    const daily: DailyCount[] = [
      { date: "2024-01-01", count: 1 },
      { date: "2024-01-02", count: 1 },
    ];
    expect(toCumulative(daily, 10).map((d) => d.count)).toEqual([11, 12]);
  });
});
