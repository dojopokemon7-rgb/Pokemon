import { describe, it, expect } from "vitest";
import {
  isOnePieceCode,
  deriveStoredCardNumber,
  baseVariantName,
  printingExternalId,
  printingVariantFromId,
} from "@/lib/utils/card-number";
import { normalizeNumber } from "@/lib/services/card-recognition.service";

/**
 * Regression guard for the game-gated `Card.number` derivation (One Piece
 * scanner "card not recognized" fix). The cross-consistency assertion is the
 * load-bearing one: it fails if a future change ever reverts One Piece to the
 * bare tail ("064"), killing the +50 number signal for every One Piece card.
 */

const OP_CODES = ["OP01-064", "ST01-012", "EB01-001", "PRB01-001"];

describe("isOnePieceCode", () => {
  it("is true for Bandai One Piece codes (OP/ST/EB/PRB + digit)", () => {
    for (const code of OP_CODES) {
      expect(isOnePieceCode(code)).toBe(true);
    }
    expect(isOnePieceCode("op01-064")).toBe(true); // case-insensitive
  });

  it("is false for Pokémon ids", () => {
    expect(isOnePieceCode("base1-4")).toBe(false);
    expect(isOnePieceCode("swsh4-20")).toBe(false);
  });
});

describe("deriveStoredCardNumber", () => {
  it("retains the FULL Bandai code for One Piece", () => {
    for (const code of OP_CODES) {
      expect(deriveStoredCardNumber(code, true)).toBe(code);
    }
  });

  it("returns the post-hyphen tail for Pokémon / other", () => {
    expect(deriveStoredCardNumber("base1-4", false)).toBe("4");
    expect(deriveStoredCardNumber("swsh4-20", false)).toBe("20");
  });

  it("returns the id itself when there is no hyphen", () => {
    expect(deriveStoredCardNumber("promo", false)).toBe("promo");
  });

  it("stored One Piece number normalizes identically to the parsed OCR code (+50 fires)", () => {
    // The invariant that makes recognition work: whatever we store must equal
    // what the recognizer produces from the OCR'd set-serial code.
    for (const code of OP_CODES) {
      const stored = deriveStoredCardNumber(code, true);
      expect(normalizeNumber(stored)).toBe(normalizeNumber(code));
    }
    // And the bare-tail form would NOT match — proving why the old behavior broke.
    expect(normalizeNumber("064")).not.toBe(normalizeNumber("OP01-064"));
  });
});

describe("baseVariantName", () => {
  it("prefers 'normal' (case-insensitive) when present", () => {
    expect(baseVariantName(["normal", "foil"])).toBe("normal");
    expect(baseVariantName(["Reverse Holofoil", "Normal"])).toBe("Normal");
  });

  it("falls back to the lexicographically smallest name", () => {
    expect(baseVariantName(["foil", "alt art"])).toBe("alt art");
  });

  it("is order-independent", () => {
    expect(baseVariantName(["foil", "alt art"])).toBe(baseVariantName(["alt art", "foil"]));
  });

  it("maps an empty name to 'normal'", () => {
    expect(baseVariantName([""])).toBe("normal");
  });
});

describe("printingExternalId", () => {
  it("keeps the base id verbatim for the base printing", () => {
    expect(printingExternalId("base1-4", "normal", "normal")).toBe("base1-4");
  });

  it("appends `::<variant>` for a non-base printing", () => {
    expect(printingExternalId("base1-4", "reverse holofoil", "normal")).toBe(
      "base1-4::reverse holofoil",
    );
  });
});

describe("printingVariantFromId", () => {
  it("returns the `::`-suffix variant for a composite id", () => {
    expect(printingVariantFromId("base1-2::unlimitedShadowlessHolofoil")).toBe(
      "unlimitedShadowlessHolofoil",
    );
    expect(printingVariantFromId("OP01-120::alt-art")).toBe("alt-art");
  });

  it("returns null for a base id with no `::`", () => {
    expect(printingVariantFromId("base1-2")).toBeNull();
    expect(printingVariantFromId("base1-4")).toBeNull();
    expect(printingVariantFromId("OP01-120")).toBeNull();
  });

  it("round-trips the inverse of printingExternalId for a non-base printing", () => {
    const id = printingExternalId("base1-4", "reverse holofoil", "normal");
    expect(printingVariantFromId(id)).toBe("reverse holofoil");
  });

  it("rejoins a variant that itself contains `::`", () => {
    expect(printingVariantFromId("base1-2::weird::variant")).toBe("weird::variant");
  });
});
