import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cardBaseProps,
  changedFilterTypes,
  gameFromExternalId,
  gameFromSearchState,
  languageFromExternalId,
} from "@/lib/analytics/card-event-props";
import { toAnalyticsChartRange } from "@/lib/analytics/chart-range";
import { trackCardsAdded } from "@/lib/analytics/card-events";
import { resetUsdInrCache } from "@/lib/analytics/track";
import { setAuthIntent, takeAuthIntent } from "@/lib/analytics/auth-intent";

describe("card-event-props", () => {
  it("derives game from the Bandai code shape", () => {
    expect(gameFromExternalId("OP01-064")).toBe("one_piece");
    expect(gameFromExternalId("OP01-120::alt-art")).toBe("one_piece");
    expect(gameFromExternalId("base1-4")).toBe("pokemon");
  });
  it("derives jp only from the _ja- marker; omits language for One Piece", () => {
    expect(languageFromExternalId("bw1b_ja-3")).toBe("jp");
    expect(languageFromExternalId("base1-4")).toBe("en");
    expect(cardBaseProps("bw1b_ja-3")).toEqual({ game: "pokemon", language: "jp" });
    expect(cardBaseProps("OP01-064")).toEqual({ game: "one_piece" });
  });
  it("maps the search page game state", () => {
    expect(gameFromSearchState("onepiece")).toBe("one_piece");
    expect(gameFromSearchState("pokemon")).toBe("pokemon");
  });
  it("changedFilterTypes reports only newly set non-empty values", () => {
    const prev = { set: "", rarity: "Rare", graded: "" };
    expect(changedFilterTypes(prev, { set: "Base", rarity: "Rare", graded: "" })).toEqual(["set"]);
    expect(changedFilterTypes(prev, { rarity: "" })).toEqual([]); // clearing is not applying
    expect(changedFilterTypes(prev, { graded: "graded", set: undefined })).toEqual(["graded"]);
  });
});

describe("toAnalyticsChartRange", () => {
  it("maps real dashboard ids honestly and drops ranges the taxonomy lacks", () => {
    expect(toAnalyticsChartRange("7D")).toBe("1W");
    expect(toAnalyticsChartRange("1M")).toBe("1M");
    expect(toAnalyticsChartRange("3M")).toBe("3M");
    expect(toAnalyticsChartRange("MAX")).toBe("ALL");
    expect(toAnalyticsChartRange("1D")).toBeNull();
    expect(toAnalyticsChartRange("6M")).toBeNull();
  });
});

describe("trackCardsAdded", () => {
  const capture = vi.fn();
  beforeEach(() => {
    capture.mockReset();
    resetUsdInrCache();
    window.posthog = { capture };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rate: null }) }));
  });

  it("fires only for really-added cards, and first_card_added once when the server says so", async () => {
    trackCardsAdded(
      [
        { externalId: "base1-4", quantity: 2, marketPrice: 5 },
        { externalId: "base1-5", quantity: 1, marketPrice: 9 },
        { externalId: "OP01-064", quantity: 1, marketPrice: null },
      ],
      {
        firstCard: true,
        results: [
          { externalId: "base1-4", ok: true },
          { externalId: "base1-5", ok: true, alreadyPresent: true }, // skipped
          { externalId: "OP01-064", ok: true },
        ],
      }
    );
    await new Promise((r) => setTimeout(r, 0));
    const names = capture.mock.calls.map((c) => c[0]);
    expect(names.filter((n) => n === "card_added")).toHaveLength(2);
    expect(names.filter((n) => n === "first_card_added")).toHaveLength(1);
    const pokemon = capture.mock.calls.find((c) => c[1].card_id === "base1-4")![1];
    expect(pokemon).toMatchObject({ game: "pokemon", language: "en", condition: "raw", quantity: 2, value_usd: 10, currency: "USD" });
    expect("value_inr" in pokemon).toBe(false); // no real rate -> omitted
    const op = capture.mock.calls.find((c) => c[1].card_id === "OP01-064")![1];
    expect("value_usd" in op).toBe(false); // unpriced card -> no money props at all
  });

  it("no first_card_added when firstCard is not true", () => {
    trackCardsAdded([{ externalId: "base1-4", quantity: 1 }], { results: [{ externalId: "base1-4", ok: true }] });
    expect(capture.mock.calls.map((c) => c[0])).toEqual(["card_added"]);
  });
});

describe("auth intent storage", () => {
  beforeEach(() => window.sessionStorage.clear());
  it("is single-use", () => {
    setAuthIntent("signup", "email");
    expect(takeAuthIntent()?.kind).toBe("signup");
    expect(takeAuthIntent()).toBeNull();
  });
  it("expires after 30 minutes and ignores corrupt data", () => {
    setAuthIntent("login", "email");
    expect(takeAuthIntent(Date.now() + 31 * 60 * 1000)).toBeNull();
    window.sessionStorage.setItem("dojo-auth-intent", "{nope");
    expect(takeAuthIntent()).toBeNull();
  });
});
