import { describe, it, expect } from "vitest";
import { normalizeText, parseSearchQuery } from "@/lib/utils/search-query";

describe("normalizeText", () => {
  it("folds accents, case, punctuation and whitespace", () => {
    expect(normalizeText("  Flabébé  ")).toBe("flabebe");
    expect(normalizeText("Mr.  Mime—V")).toBe("mr mime v");
    expect(normalizeText("MEE  16")).toBe("mee 16");
  });
  it("keeps the slash of printed numbers", () => {
    expect(normalizeText("4/102")).toBe("4/102");
  });
});

describe("parseSearchQuery", () => {
  it("treats mee-16 / mee 16 / MEE  16 as the same identifier", () => {
    for (const q of ["mee-16", "mee 16", "MEE  16"]) {
      const p = parseSearchQuery(q);
      expect(p.idCandidates).toEqual(["mee-16"]);
      expect(p.identifierLike).toBe(true);
    }
  });
  it("preserves leading zeros", () => {
    expect(parseSearchQuery("OP01-064").idCandidates).toEqual(["op01-064"]);
    expect(parseSearchQuery("mee 016").idCandidates).toEqual(["mee-016"]);
    expect(parseSearchQuery("mee 016").idCandidates).not.toEqual(parseSearchQuery("mee 16").idCandidates);
  });
  it("is not identifier-like for plain names, even name + number", () => {
    expect(parseSearchQuery("charizard").identifierLike).toBe(false);
    expect(parseSearchQuery("pikachu 25").identifierLike).toBe(false);
    expect(parseSearchQuery("pikachu").idCandidates).toEqual([]);
  });
  it("splits tokens and collects number candidates", () => {
    const p = parseSearchQuery("Charizard 4/102");
    expect(p.tokens).toEqual(["charizard", "4/102"]);
    expect(p.numberCandidates).toEqual(["4/102"]);
    expect(p.norm).toBe("charizard 4/102");
    expect(p.raw).toBe("Charizard 4/102");
  });
});
