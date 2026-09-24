import { describe, it, expect } from "vitest";
import {
  parseOcr,
  scoreCards,
  recognize,
  normalizeNumber,
  WEIGHTS,
  MAX_SCORE,
  type CatalogCard,
} from "@/lib/services/card-recognition.service";

/**
 * Unit checks for the multi-signal recognition engine (F-14). This is the
 * non-trivial logic that decides which card a noisy OCR string matches, so it
 * gets a real check: number extraction, set/name signals, additive scoring,
 * and top-N ranking.
 */

const CHARIZARD: CatalogCard = {
  id: "base1-4",
  name: "Charizard",
  number: "4/102",
  set: "Base Set",
  imageUrl: "",
};
const BLASTOISE: CatalogCard = {
  id: "base1-2",
  name: "Blastoise",
  number: "2/102",
  set: "Base Set",
  imageUrl: "",
};
const LUFFY: CatalogCard = {
  id: "OP01-001",
  name: "Monkey D. Luffy",
  number: "OP01-001",
  set: "Romance Dawn",
  imageUrl: "",
};
const POOL = [CHARIZARD, BLASTOISE, LUFFY];

describe("normalizeNumber", () => {
  it("collapses spacing and en-dashes to a comparable form", () => {
    expect(normalizeNumber("4 / 102")).toBe("4/102");
    expect(normalizeNumber("OP05 – 119")).toBe("op05-119");
    expect(normalizeNumber("SV3-224")).toBe("sv3-224");
  });
});

describe("parseOcr", () => {
  it("extracts a Pokémon collector number", () => {
    expect(parseOcr("Charizard\n120 HP\n4/102").number).toBe("4/102");
  });

  it("extracts a Bandai set-coded serial (en-dash or hyphen)", () => {
    expect(parseOcr("Monkey D. Luffy OP01-001").number).toBe("op01-001");
    expect(parseOcr("Zoro ST01–012").number).toBe("st01-012");
  });

  it("keeps letter-heavy lines as name candidates, drops number/stat lines", () => {
    const parsed = parseOcr("CHARIZARD\n120 HP\n4/102\nStage 2");
    expect(parsed.nameLines).toContain("charizard");
    expect(parsed.nameLines).not.toContain("4/102");
  });
});

describe("scoreCards", () => {
  it("awards +50 for an exact normalized number match", () => {
    // Number only, no name/set overlap: score should be exactly the number weight.
    const parsed = parseOcr("4/102");
    const top = scoreCards(parsed, [CHARIZARD], 5)[0];
    expect(top.score).toBeCloseTo(WEIGHTS.number, 5);
  });

  it("ranks the right card top when number + name + set all agree", () => {
    const [top] = scoreCards(parseOcr("CHARIZARD 120 HP 4/102 Base Set"), POOL, 5);
    expect(top.id).toBe("base1-4");
    // number(50) + set(20) + name(~30) => near the max.
    expect(top.score).toBeGreaterThan(WEIGHTS.number + WEIGHTS.set);
    expect(top.confidence).toBeGreaterThan(0.9);
  });

  it("still identifies the card from a clean name alone (no number/set)", () => {
    const [top] = scoreCards(parseOcr("Blastoise"), POOL, 5);
    expect(top.id).toBe("base1-2");
  });

  it("drops zero-signal cards and returns [] when nothing matches", () => {
    expect(scoreCards(parseOcr("xzqw random noise 999"), POOL, 5)).toEqual([]);
  });

  it("returns at most topN candidates, sorted by descending score", () => {
    const out = recognize("Charizard Base Set 4/102", POOL, 2);
    expect(out.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  it("confidence never exceeds 1 (score capped at MAX_SCORE)", () => {
    const [top] = scoreCards(parseOcr("Monkey D. Luffy Romance Dawn OP01-001"), POOL, 5);
    expect(top.confidence).toBeLessThanOrEqual(1);
    expect(top.score).toBeLessThanOrEqual(MAX_SCORE);
  });
});
