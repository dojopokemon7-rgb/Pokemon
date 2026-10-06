import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/health readiness semantics (AGENTS.md RULE 1 — Redis is OPTIONAL).
 *
 * Readiness gates on POSTGRES ONLY: Postgres is the source of truth, so an
 * unreachable DB => 503. Redis is cache-only and must NEVER fail readiness —
 * a Redis outage => HTTP 200 with status 'degraded'. Prisma + Redis are MOCKED
 * (no live DB/network), same pattern as collection-add-price-fabrication.test.ts.
 */

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const pingRedisMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({ pingRedis: pingRedisMock }));

import { GET as healthGET } from "@/app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health — Postgres-gated readiness", () => {
  it("Postgres ok + Redis ok => 200 'ok'", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    pingRedisMock.mockResolvedValue(true);

    const res = await healthGET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.services.postgres).toBe("ok");
    expect(body.services.redis).toBe("ok");
  });

  it("Postgres ok + Redis unreachable => 200 'degraded' (Redis never gates readiness)", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    pingRedisMock.mockResolvedValue(false);

    const res = await healthGET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.services.postgres).toBe("ok");
    expect(body.services.redis).toBe("unreachable");
  });

  it("Postgres unreachable => 503 (source of truth down)", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("connection refused"));
    pingRedisMock.mockResolvedValue(true);

    const res = await healthGET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.services.postgres).toBe("unreachable");
  });
});
