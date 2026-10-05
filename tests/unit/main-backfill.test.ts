import { describe, it, expect } from "vitest";
import { planMainBackfill, planRollback } from "@/lib/utils/main-backfill";

const row = (o: Partial<Parameters<typeof planMainBackfill>[0][number]> & { id: string }) => ({
  userId: "u1",
  cardId: "c1",
  isFoil: false,
  condition: null as string | null,
  isSold: false,
  ...o,
});

describe("planMainBackfill", () => {
  it("moves unassigned active rows with no Main twin", () => {
    const plan = planMainBackfill([row({ id: "a" }), row({ id: "b", cardId: "c2" })], []);
    expect(plan.movable.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.perUser.u1).toEqual({ movable: 2, conflicts: 0, skippedSold: 0 });
  });

  it("flags a conflict when Main already holds the same user+card+foil+normalized condition (uc_variant_coalesced)", () => {
    const plan = planMainBackfill(
      [row({ id: "a", condition: "nm" }), row({ id: "b", condition: "PSA 10" }), row({ id: "c", isFoil: true })],
      [row({ id: "m1", condition: " NM " }), row({ id: "m2", isFoil: true, cardId: "other" })]
    );
    expect(plan.conflicts.map((r) => r.id)).toEqual(["a"]);
    expect(plan.movable.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("does not treat another user's Main row as a conflict", () => {
    const plan = planMainBackfill([row({ id: "a" })], [row({ id: "m", userId: "u2" })]);
    expect(plan.movable).toHaveLength(1);
  });

  it("excludes and reports sold rows, and ignores sold Main rows for conflicts", () => {
    const plan = planMainBackfill([row({ id: "s", isSold: true }), row({ id: "a" })], [row({ id: "m", isSold: true })]);
    expect(plan.skippedSold.map((r) => r.id)).toEqual(["s"]);
    expect(plan.movable.map((r) => r.id)).toEqual(["a"]);
    expect(plan.perUser.u1).toEqual({ movable: 1, conflicts: 0, skippedSold: 1 });
  });
});

describe("planRollback", () => {
  it("rolls back only manifest ids currently in that user's Main", () => {
    const manifest = [
      { id: "a", userId: "u1" },
      { id: "b", userId: "u1" },
      { id: "c", userId: "u2" },
    ];
    const currentMain = [
      { id: "a", userId: "u1" },
      { id: "c", userId: "u1" }, // belongs to someone else now → ignored
    ];
    expect(planRollback(manifest, currentMain).map((r) => r.id)).toEqual(["a"]);
  });
});
