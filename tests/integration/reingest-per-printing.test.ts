import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * Per-printing re-ingest orchestrator — PURE seam tests (mocked Prisma, NO
 * network, NO credits). The live runner is guarded by the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` idiom, so importing
 * these exported functions never touches the DB or the credit gate.
 *
 * Covers (FEAT-003):
 *   (a) Pokemon match-then-upsert baseId resolution (design.md §5.1):
 *       - a seed row externalId="base1-4", scrydexId=null matched by SET NAME +
 *         number → base keeps "base1-4" (NOT the Scrydex me55c-4); non-base =
 *         "base1-4::reverse holofoil".
 *       - a row with scrydexId="me55c-4" populated → match-by-scrydexId also
 *         reuses "base1-4".
 *       - no match at all → green-field baseId = c.id.
 *   (b) Per-set assertion math (addendum MEDIUM-1):
 *       - a clean re-run: createdNonBase=0 and after-before=0 → assertion (3)
 *         passes (re-run safe, AC-5).
 *       - a cross-set Pokemon set-name split: green-field base + N-1 non-base in
 *         the Scrydex-keyed set → after-before=N vs createdNonBase=N-1 →
 *         assertion (3) FIRES.
 *   (c) set grouping key + set-name mismatch pre-check helpers.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/db", () => ({ prisma: prismaMock }));

import {
  isBasePrinting,
  setGroupingKey,
  normNumber,
  resolvePokemonBaseId,
  assertPerSetInvariants,
  findSetNameMismatches,
  type BaseIdFinders,
  type PerSetTallies,
} from "../../scripts/reingest-per-printing";
import { printingExternalId, baseVariantName } from "@/lib/utils/card-number";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isBasePrinting", () => {
  it("true for a bare id, false for a ::-suffixed composite", () => {
    expect(isBasePrinting("base1-4")).toBe(true);
    expect(isBasePrinting("OP01-120")).toBe(true);
    expect(isBasePrinting("base1-4::reverse holofoil")).toBe(false);
  });
});

describe("setGroupingKey", () => {
  it("One Piece keys by onepiece-<slug> from the set NAME", () => {
    expect(
      setGroupingKey(Game.ONE_PIECE, { setName: "Two Legends", expansionId: "op08" })
    ).toBe("onepiece-two-legends");
  });
  it("Pokemon keys by pokemon-<exp.id>", () => {
    expect(
      setGroupingKey(Game.POKEMON, { setName: "Base", expansionId: "base1" })
    ).toBe("pokemon-base1");
  });
  it("returns null when the key cannot be derived", () => {
    expect(setGroupingKey(Game.ONE_PIECE, { setName: "", expansionId: null })).toBeNull();
    expect(setGroupingKey(Game.POKEMON, { setName: "Base", expansionId: null })).toBeNull();
  });
});

describe("normNumber", () => {
  it("strips /total and leading zeros, lowercases", () => {
    expect(normNumber("4/102")).toBe("4");
    expect(normNumber("004")).toBe("4");
    expect(normNumber("H12")).toBe("h12");
    expect(normNumber(null)).toBe("");
  });
});

describe("resolvePokemonBaseId (match-then-upsert, §5.1)", () => {
  const scrydexCard = { id: "me55c-4", number: "4" };

  it("(1) matches a seed row by SET NAME + number → reuses base1-4 (NOT me55c-4)", async () => {
    const finders: BaseIdFinders = {
      byScrydexId: vi.fn().mockResolvedValue(null), // seed row has no scrydexId
      byGameSetNumber: vi
        .fn()
        .mockResolvedValue([{ externalId: "base1-4", number: "4" }]),
    };

    const baseId = await resolvePokemonBaseId(scrydexCard, "Base", finders);

    expect(baseId).toBe("base1-4");
    expect(finders.byScrydexId).toHaveBeenCalledWith("me55c-4");
    expect(finders.byGameSetNumber).toHaveBeenCalledWith("Base", "4");

    // The non-base printing rides the reused base id (owned/want-list id preserved).
    const base = baseVariantName(["normal", "reverse holofoil"]);
    expect(printingExternalId(baseId, "normal", base)).toBe("base1-4");
    expect(printingExternalId(baseId, "reverse holofoil", base)).toBe(
      "base1-4::reverse holofoil"
    );
  });

  it("(2) matches by scrydexId when populated → also reuses base1-4", async () => {
    const finders: BaseIdFinders = {
      byScrydexId: vi
        .fn()
        .mockResolvedValue({ externalId: "base1-4", number: "4" }),
      byGameSetNumber: vi.fn(), // never reached
    };

    const baseId = await resolvePokemonBaseId(scrydexCard, "Base", finders);

    expect(baseId).toBe("base1-4");
    expect(finders.byGameSetNumber).not.toHaveBeenCalled();
  });

  it("(3) no existing match → green-field baseId = c.id", async () => {
    const finders: BaseIdFinders = {
      byScrydexId: vi.fn().mockResolvedValue(null),
      byGameSetNumber: vi.fn().mockResolvedValue([]),
    };

    const baseId = await resolvePokemonBaseId(scrydexCard, "Base", finders);
    expect(baseId).toBe("me55c-4");
  });

  it("number is normalized before matching (004 → 4)", async () => {
    const finders: BaseIdFinders = {
      byScrydexId: vi.fn().mockResolvedValue(null),
      byGameSetNumber: vi
        .fn()
        .mockResolvedValue([{ externalId: "base1-4", number: "004" }]),
    };
    const baseId = await resolvePokemonBaseId({ id: "me55c-4", number: "4" }, "Base", finders);
    expect(baseId).toBe("base1-4");
  });
});

describe("assertPerSetInvariants (addendum MEDIUM-1)", () => {
  const cleanTallies = (): PerSetTallies => ({
    createdNonBase: 0,
    createdBase: 0,
    updated: 0,
    skipped: 0,
  });

  it("clean re-run: created=0, after-before=0 → passes (re-run safe, AC-5)", () => {
    expect(() =>
      assertPerSetInvariants(
        "pokemon-base1",
        { cardCount: 10 },
        { cardCount: 10 },
        cleanTallies(),
        new Map([["4", 1]])
      )
    ).not.toThrow();
  });

  it("reused base + new non-base: base is an UPDATE (createdBase=0), +N-1 non-base → passes", () => {
    // The intended apply: the base printing UPDATES the preserved existing row
    // (createdBase=0) and only the N-1 non-base printings are created, so the
    // net Card increase (N-1) exactly equals createdNonBase.
    expect(() =>
      assertPerSetInvariants(
        "pokemon-base1",
        { cardCount: 1 }, // the preserved base row already exists
        { cardCount: 3 }, // +2 non-base created
        { createdNonBase: 2, createdBase: 0, updated: 1, skipped: 0 },
        new Map([["4", 1]])
      )
    ).not.toThrow();
  });

  it("cross-set set-name split: green-field base makes net=+N but createdNonBase=N-1 → FIRES assertion (3)", () => {
    // On a seed-set-name MISS the match step green-fields the base into the
    // Scrydex-keyed set, so that set GAINS all N printings (1 green-field base +
    // N-1 non-base) → net +N, while createdNonBase counts only the N-1 non-base
    // rows → N !== N-1 fires. This is the SOLE catcher of a clean set-name miss
    // (addendum MEDIUM-1).
    expect(() =>
      assertPerSetInvariants(
        "pokemon-me55c",
        { cardCount: 0 },
        { cardCount: 3 }, // +3 (1 green-field base + 2 non-base)
        { createdNonBase: 2, createdBase: 1, updated: 0, skipped: 0 },
        new Map([["4", 1]])
      )
    ).toThrow(/assertion \(3\) failed/);
  });

  it("duplicate base per number → FIRES assertion (1)", () => {
    expect(() =>
      assertPerSetInvariants(
        "pokemon-base1",
        { cardCount: 0 },
        { cardCount: 2 },
        { createdNonBase: 0, createdBase: 2, updated: 0, skipped: 0 },
        new Map([["4", 2]]) // two base rows for number 4
      )
    ).toThrow(/assertion \(1\) failed/);
  });

  it("Card count decrease → FIRES assertion (2)", () => {
    expect(() =>
      assertPerSetInvariants(
        "pokemon-base1",
        { cardCount: 10 },
        { cardCount: 9 },
        cleanTallies(),
        new Map()
      )
    ).toThrow(/assertion \(2\) failed/);
  });
});

describe("findSetNameMismatches (Pokemon pre-check gate)", () => {
  it("returns seed set names absent from the Scrydex expansion set (case-insensitive)", () => {
    const out = findSetNameMismatches(
      ["Base", "Jungle", "Legendary Collection"],
      ["base", "JUNGLE", "Fossil"]
    );
    expect(out).toEqual(["Legendary Collection"]);
  });

  it("empty when every seed set name lines up", () => {
    expect(findSetNameMismatches(["Base", "Jungle"], ["Base", "Jungle"])).toEqual([]);
  });

  it("dedups and ignores blank seed names", () => {
    expect(findSetNameMismatches(["Base", "Base", "", "  "], ["Jungle"])).toEqual(["Base"]);
  });
});
