/**
 * Health Check API Route
 * GET /api/health
 *
 * Used by Docker Compose's healthcheck directive to verify the app is up.
 * Also checks Redis connectivity.
 */

import { NextResponse } from "next/server";
import { pingRedis } from "@/lib/redis";

export async function GET(): Promise<NextResponse> {
  const redisOk = await pingRedis();

  const status = {
    status: redisOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      app: "ok",
      redis: redisOk ? "ok" : "unreachable",
    },
  };

  return NextResponse.json(status, {
    status: redisOk ? 200 : 503,
  });
}
