/**
 * GET /api/fx/usd-inr — real USD→INR rate for analytics `value_inr`.
 *
 * PUBLIC and FAIL-OPEN (AGENTS.md RULE 7): always HTTP 200. `{ rate: null,
 * asOf: null }` when no real rate is obtainable (no EXCHANGE_RATE_API_KEY,
 * provider down, INR missing) — the client then OMITS value_inr, never guesses
 * (RULE 2). Built on fx.service (Redis-cached 24h, Redis optional — RULE 1).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUsdInrRate } from "@/lib/services/fx.service";

const ResponseSchema = z.object({
  rate: z.number().positive().nullable(),
  asOf: z.string().nullable(),
});

export async function GET(): Promise<NextResponse> {
  let body: z.infer<typeof ResponseSchema> = { rate: null, asOf: null };
  try {
    const live = await getUsdInrRate();
    const parsed = ResponseSchema.safeParse(
      live ? { rate: live.rate, asOf: live.asOf } : body
    );
    if (parsed.success) body = parsed.data;
  } catch {
    // fall through with the null payload
  }
  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
