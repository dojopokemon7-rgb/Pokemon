/**
 * Scrydex live-credit approval gate (SERVER-ONLY).
 *
 * The production plan (§1, §7.5) requires an explicit owner approval of the
 * expected credit spend BEFORE any live, credit-consuming Scrydex operation
 * (price-history pulls, Vision identify, sold-listings, bulk refresh). This
 * module is the ONE place that answers "am I allowed to spend credits right
 * now?" so the policy can't drift between call sites.
 *
 * DESIGN:
 *   - Approval is a flag the owner sets out-of-band (an admin action or the
 *     ops env var below). It is NOT auto-granted. Default = DENY.
 *   - Two mechanisms, both honoured:
 *       1. Env override `SCRYDEX_LIVE_CREDITS_APPROVED=true` — for a deliberate
 *          operator-run (e.g. a one-off script after the owner approves).
 *       2. Redis flag `scrydex:credit-approval` — set by an admin control so a
 *          running deployment can be toggled without a redeploy. Redis is
 *          OPTIONAL; if it's down we fall back to the env override only.
 *   - Documented per-operation costs (from docs/SCRYDEX_AUDIT.md): standard
 *     request = 1 credit, price_history = 3, Vision identify = 5. These feed the
 *     estimate the owner approves; they are NOT a license to spend.
 *
 * USAGE: a credit-consuming service calls `assertScrydexCreditsApproved(op, n)`
 * (throws `ScrydexCreditsNotApproved` when denied) or the softer
 * `isScrydexLiveApproved()` to branch to a cached/empty result instead.
 */
import { redis, RedisKeys } from "@/lib/redis";

/** Documented per-call credit costs (docs/SCRYDEX_AUDIT.md). */
export const SCRYDEX_CREDIT_COST = {
  standard: 1,
  priceHistory: 3,
  visionIdentify: 5,
  listings: 1,
  population: 1,
} as const;

export type ScrydexOp = keyof typeof SCRYDEX_CREDIT_COST;

export class ScrydexCreditsNotApproved extends Error {
  readonly op: ScrydexOp;
  readonly estimatedCredits: number;
  constructor(op: ScrydexOp, estimatedCredits: number) {
    super(
      `Scrydex live-credit spend is NOT approved. Operation "${op}" would cost ~${estimatedCredits} credit(s). ` +
        `An owner must approve the estimate (set SCRYDEX_LIVE_CREDITS_APPROVED=true or the admin credit-approval flag) first.`
    );
    this.name = "ScrydexCreditsNotApproved";
    this.op = op;
    this.estimatedCredits = estimatedCredits;
  }
}

function envApproved(): boolean {
  return (process.env.SCRYDEX_LIVE_CREDITS_APPROVED ?? "").toLowerCase() === "true";
}

function envOnViewApproved(): boolean {
  return (process.env.SCRYDEX_ONVIEW_ENABLED ?? "").toLowerCase() === "true";
}

/**
 * True when ON-VIEW card-detail enrichment may spend Scrydex credits.
 *
 * SEPARATE from `isScrydexLiveApproved` by design: the two card-detail POST
 * routes (enrich, ebay-sold) gate on THIS flag so on-view enrichment can be
 * enabled in production WITHOUT opening the big-bulk credit gate — and so dev /
 * verification stays a no-op (flag unset = DISABLED, no HTTP, no credits). The
 * owner enables it in prod via env `SCRYDEX_ONVIEW_ENABLED=true`. Env-only (no
 * Redis dependency) — the simplest honest check that keeps dev DENY by default.
 */
export async function isScrydexOnViewApproved(): Promise<boolean> {
  return envOnViewApproved();
}

/** True when live Scrydex credit spend is currently approved (env OR redis flag). */
export async function isScrydexLiveApproved(): Promise<boolean> {
  if (envApproved()) return true;
  try {
    const v = await redis.get(RedisKeys.scrydexCreditApproval);
    return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  } catch {
    // Redis optional — with no env override and no reachable flag, DENY.
    return false;
  }
}

/**
 * Estimate the credit cost of `count` operations of type `op`.
 * Pure; feeds the owner-facing estimate before approval.
 */
export function estimateCredits(op: ScrydexOp, count = 1): number {
  return SCRYDEX_CREDIT_COST[op] * Math.max(0, count);
}

/**
 * Throw `ScrydexCreditsNotApproved` unless live credit spend is approved.
 * Call this at the top of any credit-consuming Scrydex path.
 */
export async function assertScrydexCreditsApproved(
  op: ScrydexOp,
  count = 1
): Promise<void> {
  if (await isScrydexLiveApproved()) return;
  throw new ScrydexCreditsNotApproved(op, estimateCredits(op, count));
}
