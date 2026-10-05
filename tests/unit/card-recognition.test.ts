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
// Cards whose stored number uses the newer formats. Stored forms are the
// canonical spellings a catalog carries ("SWSH284", "TG01"); recognition must
// match them even when OCR renders a hyphenated/spaced variant.
const PIKACHU_PROMO: CatalogCard = {
  id: "swshp-SWSH284",
  name: "Pikachu",
  number: "SWSH284",
  set: "SWSH Black Star Promos",
  imageUrl: "",
};
const RAYQUAZA_TG: CatalogCard = {
  id: "swsh11tg-TG01",
  name: "Rayquaza",
  number: "TG01",
  set: "Astral Radiance Trainer Gallery",
  imageUrl: "",
};
const POOL = [CHARIZARD, BLASTOISE, LUFFY, PIKACHU_PROMO, RAYQUAZA_TG];

describe("normalizeNumber", () => {
  it("collapses spacing and en-dashes to a comparable form", () => {
    expect(normalizeNumber("4 / 102")).toBe("4/102");
    expect(normalizeNumber("OP05 – 119")).toBe("op05-119");
    expect(normalizeNumber("SV3-224")).toBe("sv3-224");
  });

  it("canonicalizes hyphenated and joined promo spellings identically", () => {
    // A letter-prefix hyphen is cosmetic: "SWSH-284" and "SWSH284" are the
    // same card number, so both must collapse to one comparable form.
    expect(normalizeNumber("SWSH-284")).toBe("swsh284");
    expect(normalizeNumber("SWSH284")).toBe("swsh284");
    expect(normalizeNumber("SVP-001")).toBe("svp001");
    expect(normalizeNumber("SVP001")).toBe("svp001");
    expect(normalizeNumber("P-001")).toBe("p001");
  });

  it("keeps a digit-group separator hyphen (set serials are not promos)", () => {
    // The hyphen in "OP05-119" sits between two digit groups — a real serial
    // separator — so it must survive (unlike the cosmetic promo hyphen).
    expect(normalizeNumber("OP05-119")).toBe("op05-119");
    expect(normalizeNumber("PRB01-001")).toBe("prb01-001");
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

  it("extracts modern promo numbers (joined and hyphenated)", () => {
    // Sword&Shield / Scarlet&Violet black-star promos: no separator printed.
    expect(parseOcr("Pikachu\nSWSH284").number).toBe("swsh284");
    expect(parseOcr("Pikachu SWSH 284").number).toBe("swsh284");
    expect(parseOcr("Charizard ex SVP-001").number).toBe("svp001");
    expect(parseOcr("Mew SVP001").number).toBe("svp001");
    expect(parseOcr("Promo card P-001").number).toBe("p001");
  });

  it("extracts Trainer/Galarian Gallery lettered fractions (keeps the TGxx side)", () => {
    // "TG01/TG30" — the card number is "TG01"; the denominator is set size.
    expect(parseOcr("Rayquaza TG01/TG30").number).toBe("tg01");
    expect(parseOcr("Zacian GG01/GG70").number).toBe("gg01");
  });

  it("does not misread a plain digit fraction as a lettered one", () => {
    expect(parseOcr("Charizard 4/102").number).toBe("4/102");
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

  it("matches a stored promo number across OCR spelling variants", () => {
    // OCR reads "SWSH 284"; the catalog stores "SWSH284" — both canonicalize
    // equal, so the number signal must fire (+50) and rank the promo top.
    const [top] = scoreCards(parseOcr("Pikachu\nSWSH 284"), POOL, 5);
    expect(top.id).toBe("swshp-SWSH284");
    expect(top.numberMatch).toBe(true);
  });

  it("matches a stored Trainer Gallery number from a TGxx/TGyy fraction", () => {
    const [top] = scoreCards(parseOcr("Rayquaza TG01/TG30"), POOL, 5);
    expect(top.id).toBe("swsh11tg-TG01");
    expect(top.numberMatch).toBe(true);
  });
});

describe("confidence (honest, signal-aware)", () => {
  it("reads HIGH for an exact number + strong name even with NO set signal", () => {
    // The old score/100 formula capped this at (50+30)/100 = 0.80. Normalizing
    // against the achievable signals (no set text ⇒ set weight excluded) lets a
    // genuinely unambiguous match read as the high confidence it deserves.
    const [top] = scoreCards(parseOcr("Charizard 4/102"), POOL, 5);
    expect(top.id).toBe("base1-4");
    expect(top.numberMatch).toBe(true);
    expect(top.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("reads LOWER when the top two candidates are near-tied (ambiguous)", () => {
    // Two cards with the SAME name and SAME set, no number to separate them:
    // the scan genuinely can't tell them apart, so the top confidence must be
    // pulled below that of a clear, unique winner.
    const twinA: CatalogCard = { id: "x-a", name: "Pidgey", number: "16/64", set: "Jungle", imageUrl: "" };
    const twinB: CatalogCard = { id: "x-b", name: "Pidgey", number: "57/64", set: "Jungle", imageUrl: "" };
    const [ambiguousTop] = scoreCards(parseOcr("Pidgey Jungle"), [twinA, twinB], 5);
    const [clearTop] = scoreCards(parseOcr("Charizard 4/102 Base Set"), POOL, 5);
    expect(ambiguousTop.confidence).toBeLessThan(clearTop.confidence);
  });

  it("never fabricates a high score for a weak (name-only, floor-level) match", () => {
    // "blasto" vs "Blastoise" clears the 0.6 floor but is a partial match with
    // no number/set; confidence must stay modest, not spike toward certainty.
    const [top] = scoreCards(parseOcr("blasto"), [BLASTOISE], 5);
    expect(top.id).toBe("base1-2");
    expect(top.confidence).toBeLessThan(0.85);
  });
});

describe("deterministic tie-break", () => {
  it("prefers an exact number match when raw scores tie", () => {
    // Engineer an exact score tie, 50 vs 50:
    //   byNumber: number hit (+50), name below floor, no set    → 50
    //   bySetName: no number, set hit (+20), name sim ~1 (+30)   → 50
    // The OCR carries byNumber's number AND bySetName's name+set. On the tie
    // the exact-number match must win per the documented tie-break order.
    const byNumber: CatalogCard = { id: "z-number", name: "Qxz", number: "7/88", set: "Nowhere", imageUrl: "" };
    const bySetName: CatalogCard = { id: "a-setname", name: "Pidgeotto", number: "99/64", set: "Jungle", imageUrl: "" };
    const ranked = scoreCards(parseOcr("Pidgeotto Jungle 7/88"), [bySetName, byNumber], 5);
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 5); // genuine tie
    expect(ranked[0].id).toBe("z-number");
    expect(ranked[0].numberMatch).toBe(true);
  });

  it("is stable by id when scores AND signals are identical", () => {
    // Same name, same (no) number, same set ⇒ identical score & nameSim ⇒ the
    // final tie-break is lexicographic id, so order is deterministic.
    const c1: CatalogCard = { id: "aaa", name: "Eevee", number: null, set: "Jungle", imageUrl: "" };
    const c2: CatalogCard = { id: "bbb", name: "Eevee", number: null, set: "Jungle", imageUrl: "" };
    const forward = scoreCards(parseOcr("Eevee"), [c1, c2], 5).map((c) => c.id);
    const reversed = scoreCards(parseOcr("Eevee"), [c2, c1], 5).map((c) => c.id);
    expect(forward).toEqual(reversed); // input order must not change output
    expect(forward[0]).toBe("aaa");
  });
});
