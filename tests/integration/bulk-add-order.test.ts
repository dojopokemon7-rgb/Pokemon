import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F-15 — Bulk Add Order. RED phase.
 *
 * Contract: when several cards are bulk-added, the batch must land at the
 * FRONT of the collection (newest first), and the batch's own selection
 * order must be preserved. So adding [C, D] on top of existing [A, B]
 * yields [C, D, A, B] — NOT [D, C, A, B] (batch reversed) and not
 * [A, B, C, D] (appended to the back).
 *
 * The collection list orders by `addedAt desc`. The current POST creates
 * each row with the DB default `now()` inside a loop, so within one batch
 * the later item (D) gets a later timestamp and sorts AHEAD of C — the
 * batch comes back reversed. The fix needs an explicit, monotonic ordering
 * the backend controls.
 *
 * This exercises `assignBulkAddOrder`, a helper the green phase will add to
 * the collection route to stamp deterministic ordering onto a batch. It
 * does not exist yet → red at import.
 */

const prismaMock = vi.hoisted(() => ({
  userCollection: { create: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Helper the green phase will introduce: given the batch (in selection
// order) and a base time, return per-row `addedAt` values such that a
// later `orderBy addedAt desc` yields the batch in selection order at the
// front. Does not exist yet → red.
import { assignBulkAddOrder } from "@/lib/utils/bulk-add-order";

interface Row { cardId: string; addedAt: Date }

beforeEach(() => vi.clearAllMocks());

describe("bulk add ordering", () => {
  it("places the batch at the front in selection order: [C, D, A, B]", () => {
    // Existing collection (older adds).
    const base = new Date("2026-01-01T00:00:00.000Z");
    // A was added more recently than B, so under `addedAt desc` the
    // existing tail is [A, B] — matching the expected result below.
    const existing: Row[] = [
      { cardId: "A", addedAt: new Date(base.getTime() - 1000) },
      { cardId: "B", addedAt: new Date(base.getTime() - 2000) },
    ];

    // Bulk add C then D (selection order).
    const stamps = assignBulkAddOrder(["C", "D"], base);
    const batch: Row[] = stamps.map((s) => ({ cardId: s.cardId, addedAt: s.addedAt }));

    // The list route sorts by addedAt desc.
    const ordered = [...existing, ...batch]
      .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
      .map((r) => r.cardId);

    expect(ordered).toEqual(["C", "D", "A", "B"]);
  });

  it("preserves batch order for larger batches", () => {
    const base = new Date("2026-06-01T00:00:00.000Z");
    const stamps = assignBulkAddOrder(["C", "D", "E"], base);
    const ordered = stamps
      .map((s) => ({ cardId: s.cardId, addedAt: s.addedAt }))
      .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
      .map((r) => r.cardId);
    expect(ordered).toEqual(["C", "D", "E"]);
  });

  it("stamps strictly distinct, front-loaded timestamps (no ties)", () => {
    const base = new Date("2026-06-01T00:00:00.000Z");
    const stamps = assignBulkAddOrder(["C", "D"], base);
    // Distinct timestamps so ordering is deterministic (no same-ms ties).
    expect(stamps[0].addedAt.getTime()).not.toBe(stamps[1].addedAt.getTime());
    // The whole batch is at/after the base "now" so it lands in front of
    // everything added before this request.
    for (const s of stamps) {
      expect(s.addedAt.getTime()).toBeGreaterThanOrEqual(base.getTime());
    }
  });
});
