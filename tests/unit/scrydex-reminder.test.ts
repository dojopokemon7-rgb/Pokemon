import { describe, it, expect } from "vitest";
import {
  parseReminderConfig, nextRenewalDate, daysUntil, dueReminder, newlyCrossed, todayInTz, parseYMD, formatYMD,
} from "@/lib/utils/scrydex-reminder";

const ok = { SCRYDEX_REMINDER_ENABLED: "true", SCRYDEX_RENEWAL_DATE: "2026-01-31" };
const ymd = (s: string) => parseYMD(s)!;
const next = (a: string, c: "monthly" | "yearly", t: string) => formatYMD(nextRenewalDate(ymd(a), c, ymd(t)).renewal);

describe("parseReminderConfig", () => {
  it("applies defaults", () => {
    const p = parseReminderConfig(ok);
    expect(p.error).toBeNull();
    expect(p.enabled).toBe(true);
    expect(p.config).toMatchObject({ cycle: "monthly", tz: "Asia/Kolkata", daysBefore: [7, 3, 1, 0], lowCreditPercents: [20, 5], to: ["dojo.collect@nodwin.com"], planLabel: null });
  });
  it("only 'true' enables", () => {
    expect(parseReminderConfig({ ...ok, SCRYDEX_REMINDER_ENABLED: "1" }).enabled).toBe(false);
    expect(parseReminderConfig({}).enabled).toBe(false);
  });
  it("empty credit percent disables credit alerts", () => {
    expect(parseReminderConfig({ ...ok, SCRYDEX_LOW_CREDIT_PERCENT: "" }).config!.lowCreditPercents).toEqual([]);
  });
  it.each([
    [{ SCRYDEX_RENEWAL_DATE: "" }, "SCRYDEX_RENEWAL_DATE"],
    [{ SCRYDEX_RENEWAL_DATE: "2026-02-30" }, "valid YYYY-MM-DD"],
    [{ SCRYDEX_RENEWAL_CYCLE: "weekly" }, "monthly"],
    [{ SCRYDEX_REMINDER_TZ: "Mars/Base" }, "timezone"],
    [{ SCRYDEX_REMINDER_DAYS_BEFORE: "7,x" }, "DAYS_BEFORE"],
    [{ SCRYDEX_REMINDER_DAYS_BEFORE: "-1" }, "DAYS_BEFORE"],
    [{ SCRYDEX_REMINDER_DAYS_BEFORE: "1.5" }, "whole"],
    [{ SCRYDEX_LOW_CREDIT_PERCENT: "101" }, "LOW_CREDIT"],
    [{ SCRYDEX_REMINDER_TO: "a@b.com,nope" }, "invalid email"],
    [{ SCRYDEX_PLAN_LABEL: "x".repeat(81) }, "PLAN_LABEL"],
  ])("invalid %j -> clear reason", (over, frag) => {
    const p = parseReminderConfig({ ...ok, ...over });
    expect(p.config).toBeNull();
    expect(p.error).toContain(frag);
  });
});

describe("nextRenewalDate", () => {
  it("clamps month-end and anchor day drives later months", () => {
    expect(next("2026-01-31", "monthly", "2026-02-01")).toBe("2026-02-28");
    expect(next("2026-01-31", "monthly", "2026-03-01")).toBe("2026-03-31");
    expect(next("2026-01-31", "monthly", "2026-04-01")).toBe("2026-04-30");
  });
  it("leap years", () => {
    expect(next("2026-01-31", "monthly", "2028-02-10")).toBe("2028-02-29");
    expect(next("2024-02-29", "yearly", "2025-01-01")).toBe("2025-02-28");
    expect(next("2024-02-29", "yearly", "2027-03-01")).toBe("2028-02-29");
  });
  it("renewal day itself counts (>= today)", () => {
    expect(next("2026-01-15", "monthly", "2026-06-15")).toBe("2026-06-15");
    expect(next("2026-01-15", "monthly", "2026-06-16")).toBe("2026-07-15");
  });
  it("yearly + year rollover", () => {
    expect(next("2025-12-15", "yearly", "2026-12-16")).toBe("2027-12-15");
    expect(next("2025-12-15", "monthly", "2026-12-16")).toBe("2027-01-15");
  });
  it("future anchor is the next renewal", () => {
    expect(next("2027-05-10", "monthly", "2026-01-01")).toBe("2027-05-10");
  });
  it("cycleStart is the previous renewal", () => {
    const r = nextRenewalDate(ymd("2026-01-31"), "monthly", ymd("2026-03-05"));
    expect(formatYMD(r.cycleStart)).toBe("2026-02-28");
  });
});

describe("daysUntil / dueReminder / newlyCrossed / todayInTz", () => {
  it("counts calendar days", () => {
    expect(daysUntil(ymd("2026-03-01"), ymd("2026-02-28"))).toBe(1);
    expect(daysUntil(ymd("2026-03-01"), ymd("2026-03-01"))).toBe(0);
  });
  it("due only when days match", () => {
    expect(dueReminder(3, [7, 3, 1, 0])).toBe(3);
    expect(dueReminder(0, [7, 3, 1, 0])).toBe(0);
    expect(dueReminder(5, [7, 3, 1, 0])).toBeNull();
  });
  it("most severe crossed first; already-sent excluded", () => {
    expect(newlyCrossed(4, [20, 5], new Set())).toEqual([5, 20]);
    expect(newlyCrossed(18, [20, 5], new Set())).toEqual([20]);
    expect(newlyCrossed(4, [20, 5], new Set([5, 20]))).toEqual([]);
    expect(newlyCrossed(30, [20, 5], new Set())).toEqual([]);
    expect(newlyCrossed(20, [20, 5], new Set())).toEqual([20]);
  });
  it("timezone day boundary", () => {
    const t = new Date("2026-03-01T19:00:00Z"); // 00:30 on 2 Mar in Kolkata
    expect(formatYMD(todayInTz(t, "Asia/Kolkata"))).toBe("2026-03-02");
    expect(formatYMD(todayInTz(t, "UTC"))).toBe("2026-03-01");
  });
});
