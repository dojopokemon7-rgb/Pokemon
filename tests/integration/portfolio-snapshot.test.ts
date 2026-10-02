import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FR-5 (AC-13) — portfolio add-snapshot.
 *
 * POST /api/users/me/collection writes ONE add-snapshot PricingHistory point
 * for each PRICED card (addPrice != null && > 0), skips it for an unpriced
 * one, and the add still succeeds either way (the snapshot is best-effort —
 * a snapshot failure never fails the add). A null/zero price writes NO row
 * (NFR-2 — never a fabricated $0 point). assignBulkAddOrder's
 * strictly-decreasing addedAt is preserved (F-15 bulk-add-order.test.ts stays
 * green — this test sits alongside it).
 *
 * Mocks the auth guard + Prisma; no live DB.
 */

const prismaMock = vi.hoisted(() => ({
  cardSet: { upsert: vi.fn() },
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  userCollection: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  pricingHistory: { createMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Authenticated as USER_ID for all POSTs here.
const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({
    unauthorized: null,
    session: { user: { id: USER_ID } },
  })),
}));

import { POST } from "@/app/api/users/me/collection/route";

function postRequest(cards: unknown[]): Request {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cards }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.userCollection.findMany.mockResolvedValue([]); // no existing copy
  prismaMock.userCollection.create.mockResolvedValue({ id: "uc_1" });
  prismaMock.userCollection.update.mockResolvedValue({ id: "uc_1" });
  prismaMock.pricingHistory.createMany.mockResolvedValue({ count: 1 });
});

describe("add-snapshot PricingHistory on POST add (AC-13)", () => {
  it("writes an add-snapshot point for a PRICED card and the add succeeds", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_1", marketPrice: 25.5 });

    const res = await POST(
      postRequest([{ externalId: "base1-4", name: "Charizard", marketPrice: 25.5 }])
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.added).toBe(1);

    expect(prismaMock.pricingHistory.createMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.pricingHistory.createMany.mock.calls[0][0];
    expect(arg.data[0]).toMatchObject({
      cardId: "card_1",
      priceMarket: 25.5,
      source: "add-snapshot",
      variant: "normal",
      condition: "NM",
      currency: "USD",
    });
  });

  it("writes NO snapshot for an UNPRICED card, and the add still succeeds", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_2", marketPrice: null });

    const res = await POST(
      postRequest([{ externalId: "base1-5", name: "Mystery", marketPrice: null }])
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.added).toBe(1);
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
  });

  it("writes NO snapshot for a zero-priced card (never a fabricated $0 point)", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_3", marketPrice: 0 });

    const res = await POST(
      postRequest([{ externalId: "base1-6", name: "Free", marketPrice: 0 }])
    );
    expect(res.status).toBe(200);
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
  });

  it("still succeeds when the snapshot write throws (best-effort, non-fatal)", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_4", marketPrice: 10 });
    prismaMock.pricingHistory.createMany.mockRejectedValue(new Error("snapshot db down"));

    const res = await POST(
      postRequest([{ externalId: "base1-7", name: "Risky", marketPrice: 10 }])
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.added).toBe(1);
  });

  it("stamps strictly-decreasing addedAt across a batch so it lands at the front in order (F-15)", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    // Each create returns a distinct id; price present so adds succeed.
    prismaMock.card.create
      .mockResolvedValueOnce({ id: "card_C", marketPrice: 5 })
      .mockResolvedValueOnce({ id: "card_D", marketPrice: 5 });

    const res = await POST(
      postRequest([
        { externalId: "C", name: "C", marketPrice: 5 },
        { externalId: "D", name: "D", marketPrice: 5 },
      ])
    );
    expect((await res.json()).added).toBe(2);

    // Two creates, each with an addedAt; the first selected (C) must sort
    // AHEAD of the later one (D) under `addedAt desc` → strictly decreasing.
    const createCalls = prismaMock.userCollection.create.mock.calls;
    expect(createCalls).toHaveLength(2);
    const addedAtC = createCalls[0][0].data.addedAt.getTime();
    const addedAtD = createCalls[1][0].data.addedAt.getTime();
    expect(addedAtC).toBeGreaterThan(addedAtD);
  });
});
