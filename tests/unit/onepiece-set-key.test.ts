import { describe, it, expect } from "vitest";
import {
  pickOnePieceSetKeeper,
  isCodeStyleOnePieceSetId,
  isThirdVariantOnePieceSetId,
  type OnePieceSetRow,
} from "@/lib/utils/onepiece-set-key";

/**
 * Canonical keeper rule for the One Piece set reconciliation (DB-free).
 * plain-slug beats third-variant beats CODE row; highest cardCount wins within
 * a tier; a single-row group (lone CODE row OR genuine promo set) is left
 * untouched. Also pins the "deletion set ⊆ zero-card losers" half of the
 * never-delete-a-non-empty-set guard (the transactional re-query guard itself
 * lives in the script).
 */

const row = (externalId: string, cardCount: number, name = "Romance Dawn"): OnePieceSetRow => ({
  externalId,
  name,
  cardCount,
});

describe("pickOnePieceSetKeeper", () => {
  it("plain slug beats a 0-card CODE row", () => {
    const { keeper, losers } = pickOnePieceSetKeeper([
      row("onepiece-romance-dawn", 121),
      row("onepiece-OP01", 0),
    ]);
    expect(keeper.externalId).toBe("onepiece-romance-dawn");
    expect(losers.map((l) => l.externalId)).toEqual(["onepiece-OP01"]);
  });

  it("split set: slug keeps, the CODE row with a few cards is a move candidate", () => {
    const { keeper, losers } = pickOnePieceSetKeeper([
      row("onepiece-paramount-war", 121, "Paramount War"),
      row("onepiece-OP02", 2, "Paramount War"),
    ]);
    expect(keeper.externalId).toBe("onepiece-paramount-war");
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ externalId: "onepiece-OP02", cardCount: 2 });
  });

  it("third-variant ranks below plain slug but above the CODE row", () => {
    const { keeper, losers } = pickOnePieceSetKeeper([
      row("onepiece-one-piece-romance-dawn", 8),
      row("onepiece-romance-dawn", 121),
      row("onepiece-OP01", 0),
    ]);
    expect(keeper.externalId).toBe("onepiece-romance-dawn");
    expect(losers.map((l) => l.externalId).sort()).toEqual([
      "onepiece-OP01",
      "onepiece-one-piece-romance-dawn",
    ]);
  });

  it("lone CODE row (no slug twin) is its own keeper, zero losers — left untouched", () => {
    const { keeper, losers } = pickOnePieceSetKeeper([row("onepiece-op13", 5)]);
    expect(keeper.externalId).toBe("onepiece-op13");
    expect(losers).toEqual([]);
  });

  it("genuine promo set (unique name, single row) keeps itself, no losers", () => {
    const { keeper, losers } = pickOnePieceSetKeeper([
      row("onepiece-xxx-release-event-cards", 2, "XXX Release Event Cards"),
    ]);
    expect(keeper.externalId).toBe("onepiece-xxx-release-event-cards");
    expect(losers).toEqual([]);
  });

  it("within a tier the higher card count wins", () => {
    const { keeper } = pickOnePieceSetKeeper([
      row("onepiece-romance-dawn-a", 50),
      row("onepiece-romance-dawn-b", 120),
    ]);
    expect(keeper.externalId).toBe("onepiece-romance-dawn-b");
  });

  it("equal counts in a tier tie-break by externalId ascending (deterministic)", () => {
    const { keeper } = pickOnePieceSetKeeper([
      row("onepiece-zzz", 10),
      row("onepiece-aaa", 10),
    ]);
    expect(keeper.externalId).toBe("onepiece-aaa");
  });

  it("throws on an empty group (programmer error)", () => {
    expect(() => pickOnePieceSetKeeper([])).toThrow();
  });

  it("guard: the deletion set (0-card losers) never includes a non-empty loser", () => {
    // The script deletes a loser only once it is 0-card; a loser that still
    // holds cards (count > 0) must be re-pointed first, never in the delete set.
    const { losers } = pickOnePieceSetKeeper([
      row("onepiece-paramount-war", 121, "Paramount War"),
      row("onepiece-OP02", 2, "Paramount War"),
      row("onepiece-one-piece-paramount-war", 0, "Paramount War"),
    ]);
    const deletableNow = losers.filter((l) => l.cardCount === 0);
    expect(deletableNow.every((l) => l.cardCount === 0)).toBe(true);
    // The non-empty loser is NOT eligible for an immediate delete.
    expect(deletableNow.map((l) => l.externalId)).not.toContain("onepiece-OP02");
  });
});

describe("One Piece set-id classifiers", () => {
  it("isCodeStyleOnePieceSetId matches OP/ST/EB/PRB codes, case-insensitive", () => {
    expect(isCodeStyleOnePieceSetId("onepiece-OP01")).toBe(true);
    expect(isCodeStyleOnePieceSetId("onepiece-op01")).toBe(true);
    expect(isCodeStyleOnePieceSetId("onepiece-ST36")).toBe(true);
    expect(isCodeStyleOnePieceSetId("onepiece-EB01")).toBe(true);
    expect(isCodeStyleOnePieceSetId("onepiece-PRB02")).toBe(true);
    expect(isCodeStyleOnePieceSetId("onepiece-romance-dawn")).toBe(false);
    expect(isCodeStyleOnePieceSetId("onepiece-one-piece-romance-dawn")).toBe(false);
  });

  it("isThirdVariantOnePieceSetId matches the 'One Piece '-prefixed slug", () => {
    expect(isThirdVariantOnePieceSetId("onepiece-one-piece-romance-dawn")).toBe(true);
    expect(isThirdVariantOnePieceSetId("onepiece-romance-dawn")).toBe(false);
    expect(isThirdVariantOnePieceSetId("onepiece-OP01")).toBe(false);
  });
});
