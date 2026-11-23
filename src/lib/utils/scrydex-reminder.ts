/**
 * Scrydex renewal + low-credit reminder — PURE logic (AGENTS.md RULE 11).
 *
 * No I/O, no clock reads: callers pass `now`/`today`. Everything the client
 * tunes comes from SCRYDEX_REMINDER_* env vars, parsed ONCE here with a clear
 * reason on failure. Invalid config never throws; the job reports
 * "not configured / invalid: <reason>" and sends nothing.
 *
 * Dates are calendar dates ({y,m,d}, m = 1..12) so day boundaries are exact and
 * independent of the server's timezone (the client's timezone is applied once,
 * in `todayInTz`).
 */
import { z } from "zod";

export type Cycle = "monthly" | "yearly";
export interface YMD {
  y: number;
  m: number;
  d: number;
}

export interface ReminderConfig {
  renewalDate: YMD;
  cycle: Cycle;
  tz: string;
  daysBefore: number[]; // sorted desc, unique
  lowCreditPercents: number[]; // sorted desc, unique; [] disables credit alerts
  to: string[];
  planLabel: string | null;
}

export interface ParsedReminder {
  /** SCRYDEX_REMINDER_ENABLED === "true" */
  enabled: boolean;
  /** Present when the settings are valid (even if disabled). */
  config: ReminderConfig | null;
  /** Human reason when settings are invalid; null when valid. */
  error: string | null;
}

export const DEFAULT_TZ = "Asia/Kolkata";
export const DEFAULT_DAYS_BEFORE = "7,3,1,0";
export const DEFAULT_LOW_CREDIT = "20,5";
export const DEFAULT_TO = "dojo.collect@nodwin.com";
const PLAN_LABEL_MAX = 80;

// ---------------------------------------------------------------- date helpers

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const formatYMD = (v: YMD): string => `${pad(v.y, 4)}-${pad(v.m)}-${pad(v.d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNumber = (v: YMD) => Math.round(Date.UTC(v.y, v.m - 1, v.d) / 86_400_000);
const cmp = (a: YMD, b: YMD) => dayNumber(a) - dayNumber(b);

/** Strict YYYY-MM-DD → YMD (rejects 2026-02-30 etc.), else null. */
export function parseYMD(s: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = { y: +m[1], m: +m[2], d: +m[3] };
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.m)) return null;
  return v;
}

/** Calendar date "now" in an IANA timezone (Intl only, no deps). */
export function todayInTz(now: Date, tz: string): YMD {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * anchor + `cycles` whole cycles, keeping the ANCHOR's day-of-month and clamping
 * to the target month's last day (31 Jan → 28/29 Feb → 31 Mar). `cycles` may be
 * negative. Clamping is per-target-month, never carried forward.
 */
function addCycles(anchor: YMD, cycle: Cycle, cycles: number): YMD {
  const months = cycles * (cycle === "yearly" ? 12 : 1);
  const idx = anchor.y * 12 + (anchor.m - 1) + months;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { y, m, d: Math.min(anchor.d, daysInMonth(y, m)) };
}

/**
 * First renewal >= today, plus the start of that billing cycle (the renewal
 * before it). Anchor may be in the past (rolled forward) or the future.
 */
export function nextRenewalDate(
  anchor: YMD,
  cycle: Cycle,
  today: YMD
): { renewal: YMD; cycleStart: YMD } {
  const step = cycle === "yearly" ? 12 : 1;
  const monthsDiff = (today.y - anchor.y) * 12 + (today.m - anchor.m);
  let n = Math.max(0, Math.ceil(monthsDiff / step));
  // A future anchor is itself the next renewal (n = 0).
  let renewal = addCycles(anchor, cycle, n);
  if (cmp(renewal, today) < 0) renewal = addCycles(anchor, cycle, ++n);
  return { renewal, cycleStart: addCycles(anchor, cycle, n - 1) };
}

/** Whole calendar days from `today` to `target` (negative = past). */
export const daysUntil = (target: YMD, today: YMD): number =>
  dayNumber(target) - dayNumber(today);

/** The `daysBefore` entry matching today, or null (0 = renewal day). */
export const dueReminder = (days: number, daysBefore: readonly number[]): number | null =>
  daysBefore.includes(days) ? days : null;

/**
 * Thresholds (percent) that `pct` has fallen to/below and that were not yet
 * alerted this cycle, most severe (lowest) first. Caller sends ONLY the first.
 */
export function newlyCrossed(
  pct: number,
  thresholds: readonly number[],
  alreadySent: ReadonlySet<number>
): number[] {
  return thresholds
    .filter((t) => pct <= t && !alreadySent.has(t))
    .sort((a, b) => a - b);
}

export const creditPercent = (remaining: number, total: number): number | null =>
  total > 0 ? (remaining / total) * 100 : null;

// ---------------------------------------------------------------- config parse

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");

const EmailSchema = z.string().email();

function parseIntList(name: string, raw: string, min: number, max: number): number[] | string {
  const out: number[] = [];
  for (const item of csv(raw)) {
    const n = Number(item);
    if (!/^\d+(\.\d+)?$/.test(item) || !Number.isFinite(n) || n < min || n > max) {
      return `${name} has invalid value "${item}" (expected numbers ${min}-${max}, comma separated)`;
    }
    out.push(n);
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

/** Parse + validate the env once. Never throws. */
export function parseReminderConfig(
  env: Record<string, string | undefined>
): ParsedReminder {
  const enabled = (env.SCRYDEX_REMINDER_ENABLED ?? "").trim() === "true";
  const fail = (error: string): ParsedReminder => ({ enabled, config: null, error });

  const rawDate = (env.SCRYDEX_RENEWAL_DATE ?? "").trim();
  if (!rawDate) return fail("SCRYDEX_RENEWAL_DATE is not set (expected YYYY-MM-DD)");
  const renewalDate = parseYMD(rawDate);
  if (!renewalDate) {
    return fail(`SCRYDEX_RENEWAL_DATE "${rawDate}" is not a valid YYYY-MM-DD date`);
  }

  const rawCycle = (env.SCRYDEX_RENEWAL_CYCLE ?? "").trim().toLowerCase() || "monthly";
  if (rawCycle !== "monthly" && rawCycle !== "yearly") {
    return fail(`SCRYDEX_RENEWAL_CYCLE "${rawCycle}" must be "monthly" or "yearly"`);
  }

  const tz = (env.SCRYDEX_REMINDER_TZ ?? "").trim() || DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    return fail(`SCRYDEX_REMINDER_TZ "${tz}" is not a valid IANA timezone`);
  }

  const days = parseIntList(
    "SCRYDEX_REMINDER_DAYS_BEFORE",
    env.SCRYDEX_REMINDER_DAYS_BEFORE ?? DEFAULT_DAYS_BEFORE,
    0,
    366
  );
  if (typeof days === "string") return fail(days);
  if (days.some((n) => !Number.isInteger(n))) {
    return fail("SCRYDEX_REMINDER_DAYS_BEFORE must be whole numbers");
  }

  // Empty string DISABLES the credit alert; only unset falls back to the default.
  const pcts = parseIntList(
    "SCRYDEX_LOW_CREDIT_PERCENT",
    env.SCRYDEX_LOW_CREDIT_PERCENT ?? DEFAULT_LOW_CREDIT,
    0,
    100
  );
  if (typeof pcts === "string") return fail(pcts);

  const to = csv(env.SCRYDEX_REMINDER_TO || DEFAULT_TO);
  const bad = to.find((e) => !EmailSchema.safeParse(e).success);
  if (bad) return fail(`SCRYDEX_REMINDER_TO has invalid email "${bad}"`);
  if (to.length === 0) return fail("SCRYDEX_REMINDER_TO has no recipients");

  const label = (env.SCRYDEX_PLAN_LABEL ?? "").trim();
  if (label.length > PLAN_LABEL_MAX) {
    return fail(`SCRYDEX_PLAN_LABEL is longer than ${PLAN_LABEL_MAX} characters`);
  }

  return {
    enabled,
    error: null,
    config: {
      renewalDate,
      cycle: rawCycle,
      tz,
      daysBefore: days,
      lowCreditPercents: pcts,
      to,
      planLabel: label || null,
    },
  };
}
