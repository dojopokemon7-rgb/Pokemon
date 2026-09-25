import { describe, it, expect } from "vitest";
import { buildEbayQuery } from "@/lib/services/ebay.service";

/**
 * Guards the eBay query construction — the bug that made One Piece "Sellers
 * on the Floor" return zero listings. Verified against the live Browse API:
 * quoting the set name + rarity as required phrases zeroed One Piece results,
 * while the Bandai code as a loose keyword returns real listings.
 */
describe("buildEbayQuery", () => {
  it("Pokémon: quotes name + set + number as exact phrases", () => {
    expect(
      buildEbayQuery({ game: "pokemon", name: "Charizard ex", set: "Obsidian Flames", number: "125/197" })
    ).toBe('"Charizard ex" "Obsidian Flames" "125/197"');
  });

  it("One Piece: quotes the name, appends the code UNQUOTED, drops set/grade", () => {
    // The winning shape (live-verified): the set name + rarity are NOT forced
    // as phrases, and the Bandai code is a loose keyword.
    expect(
      buildEbayQuery({ game: "onepiece", name: "Monkey D. Luffy", set: "Romance Dawn", number: "OP01-001" })
    ).toBe('"Monkey D. Luffy" OP01-001');
  });

  it("skips empty optional fields without emitting bare quotes", () => {
    expect(buildEbayQuery({ game: "pokemon", name: "Pikachu" })).toBe('"Pikachu"');
    expect(buildEbayQuery({ game: "onepiece", name: "Zoro" })).toBe('"Zoro"');
  });
});
