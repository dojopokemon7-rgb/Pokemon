import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "@/lib/utils/search-query";
import { rankCards, maxTypoDistance, hasNameHit } from "@/lib/utils/search-rank";

const c = (externalId: string, name: string, number = "1", setName = "Set", rarity = "Common", tags: string[] = []) => ({
  externalId, name, number, setName, rarity, tags,
});
const ids = (q: string, cards: ReturnType<typeof c>[]) =>
  rankCards(parseSearchQuery(q), cards).map((x) => x.externalId);

describe("maxTypoDistance", () => {
  it("is 0 below 4 chars, 1 for 4-7, 2 for 8+", () => {
    expect([3, 4, 7, 8, 12].map(maxTypoDistance)).toEqual([0, 1, 1, 2, 2]);
  });
});

describe("rankCards tiers", () => {
  const cards = [
    c("z-9", "Mega Pikachu", "9", "Alpha"),
    c("z-8", "Pikachu", "8", "Alpha"),
    c("z-7", "Pikachu V", "7", "Alpha"),
    c("z-6", "Pikchu", "6", "Alpha"),
    c("z-5", "Raichu", "5", "Pikachu Set"),
    c("z-4", "Raichu", "4", "Alpha", "Pikachu Holo"),
  ];
  it("exact name > prefix > word match > typo > set > rarity", () => {
    expect(ids("pikachu", cards)).toEqual(["z-8", "z-7", "z-9", "z-6", "z-5", "z-4"]);
  });
  it("exact externalId beats everything", () => {
    const list = [c("a-1", "Mee", "1"), c("mee-16", "Energy", "16", "Mee Set")];
    expect(ids("mee-16", list)).toEqual(["mee-16"]);
  });
  it("exact number + set code ranks when the id differs in case", () => {
    expect(ids("op01 064", [c("OP01-064", "Law", "OP01-064")])).toEqual(["OP01-064"]);
  });
  it("identifier queries never return a different id", () => {
    const list = [c("mee-16", "A", "16"), c("mee-17", "B", "17"), c("mee-116", "C", "116")];
    expect(ids("mee-17", list)).toEqual(["mee-17"]);
    expect(ids("mee-18", list)).toEqual([]);
  });
  it("leading zeros are not equal for exact number", () => {
    expect(ids("mee 016", [c("mee-16", "A", "16")])).toEqual([]);
  });
  it("multi-token: cards matching every token first", () => {
    const list = [c("a-1", "Charizard", "1", "Other"), c("b-1", "Charizard", "1", "Base Set")];
    expect(ids("charizard base", list)).toEqual(["b-1", "a-1"]);
  });
  it("ties break by externalId asc", () => {
    expect(ids("dog", [c("b-1", "Dog"), c("a-1", "Dog")])).toEqual(["a-1", "b-1"]);
  });
  it("no typo tolerance below 4 chars; none for numbers", () => {
    expect(ids("cat", [c("a-1", "Cot")])).toEqual([]);
  });
  it("hasNameHit reports name-level matches only", () => {
    const p = parseSearchQuery("pikachu");
    expect(hasNameHit(p, [c("a", "Raichu", "1", "Pikachu Set")])).toBe(false);
    expect(hasNameHit(p, [c("a", "Pikchu")])).toBe(true);
  });
});
