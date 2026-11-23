/**
 * Scrydex account usage read (SERVER-ONLY) — GET /account/v1/usage.
 *
 * COST: this endpoint is a standard request and CONSUMES 1 CREDIT per call
 * (docs/SCRYDEX_AUDIT.md "Credit usage updates on a 20–30 minute delay").
 * It therefore goes through the SOFT credit gate (`isScrydexLiveApproved`):
 * gate closed → no HTTP, "unavailable". Calls are also cached in Redis for
 * USAGE_FRESH_MS (Scrydex itself only updates every ~20–30 min), so the daily
 * real job runs cost at most ~1 credit per hour of activity. dryRun reads the\n * cache only (readCachedUsage): no live call, no credit, no cache write.
 *
 * RULE 2: a failed/invalid/gated read is `null` (unavailable) — numbers are
 * never invented. RULE 1: Redis is optional; every access is try/catch.
 */
import { z } from "zod";
import { redis, RedisKeys } from "@/lib/redis";
import { scrydexHeaders } from "@/lib/services/scrydex.service";
import { isScrydexLiveApproved } from "@/lib/services/scrydex-credit-gate";

const USAGE_URL = "https://api.scrydex.com/account/v1/usage";
const TIMEOUT_MS = 8_000;
const USAGE_FRESH_MS = 60 * 60 * 1000;
const CACHE_TTL_S = 7 * 24 * 3600;

const num = z.coerce.number().finite().nonnegative();
// Tolerates extra fields; accepts the body bare or wrapped in {data:{...}}.
const BodySchema = z.object({
  total_credits: num,
  remaining_credits: num,
  used_credits: num.nullish(),
  overage_credit_rate: num.nullish(),
});
const CachedSchema = BodySchema.extend({ fetchedAt: z.string() });

export interface ScrydexUsage {
  totalCredits: number;
  remainingCredits: number;
  usedCredits: number | null;
  overageCreditRate: number | null;
  fetchedAt: string; // ISO
}

function toUsage(b: z.infer<typeof BodySchema>, fetchedAt: string): ScrydexUsage {
  return {
    totalCredits: b.total_credits,
    remainingCredits: b.remaining_credits,
    usedCredits: b.used_credits ?? null,
    overageCreditRate: b.overage_credit_rate ?? null,
    fetchedAt,
  };
}

/** Last cached reading regardless of age (admin card). Never calls Scrydex. */
export async function readCachedUsage(): Promise<ScrydexUsage | null> {
  try {
    const raw = await redis.get(RedisKeys.scrydexUsage);
    if (!raw) return null;
    const p = CachedSchema.safeParse(JSON.parse(raw));
    return p.success ? toUsage(p.data, p.data.fetchedAt) : null;
  } catch {
    return null;
  }
}

/**
 * Current usage: fresh cache → else live read (gated). null = unavailable.
 * Never throws.
 */
export async function getScrydexUsage(now: Date = new Date()): Promise<ScrydexUsage | null> {
  const cached = await readCachedUsage();
  if (cached && now.getTime() - Date.parse(cached.fetchedAt) < USAGE_FRESH_MS) return cached;
  try {
    if (!(await isScrydexLiveApproved())) return null; // costs 1 credit → gated
    const res = await fetch(USAGE_URL, {
      headers: scrydexHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[scrydex-usage] HTTP ${res.status}`);
      return null;
    }
    const json: unknown = await res.json();
    const wrapped = (json as { data?: unknown } | null)?.data;
    const parsed = BodySchema.safeParse(json).success
      ? BodySchema.safeParse(json)
      : BodySchema.safeParse(wrapped);
    if (!parsed.success) {
      console.error("[scrydex-usage] unexpected response shape");
      return null;
    }
    const usage = toUsage(parsed.data, now.toISOString());
    try {
      await redis.set(RedisKeys.scrydexUsage, JSON.stringify({ ...parsed.data, fetchedAt: usage.fetchedAt }), "EX", CACHE_TTL_S);
    } catch {
      /* Redis optional */
    }
    return usage;
  } catch (err) {
    // Message only: never log headers/keys.
    console.error("[scrydex-usage] read failed:", err instanceof Error ? err.message : "unknown");
    return null;
  }
}
