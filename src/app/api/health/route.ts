/**
 * Health Check API Route
 * GET /api/health
 *
 * Used by Docker Compose's healthcheck directive to gate container readiness.
 *
 * READINESS gates on POSTGRES ONLY. Postgres is the source of truth: if it is
 * unreachable the app cannot serve data, so we return 503. Redis is CACHE-ONLY
 * and OPTIONAL (AGENTS.md RULE 1) — a Redis outage must NEVER fail a request or
 * readiness, every cache read/write falls through to live data. So Redis down =
 * HTTP 200 with status 'degraded', purely informational; it never returns 503.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { pingRedis } from "@/lib/redis";

export async function GET(): Promise<NextResponse> {
  let postgresOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    postgresOk = false;
  }

  // Informational only — never gates readiness (RULE 1).
  const redisOk = await pingRedis();

  const status = {
    status: postgresOk ? (redisOk ? "ok" : "degraded") : "error",
    timestamp: new Date().toISOString(),
    services: {
      app: "ok",
      postgres: postgresOk ? "ok" : "unreachable",
      redis: redisOk ? "ok" : "unreachable",
    },
  };

  return NextResponse.json(status, {
    status: postgresOk ? 200 : 503,
  });
}
