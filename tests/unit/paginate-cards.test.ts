import { describe, it, expect } from "vitest";
import { flattenDedupe, getNextCursorParam } from "@/lib/utils/paginate-cards";

describe("flattenDedupe", () => {
  it("keeps the first occurrence of each key, preserving page/item order", () => {
    const pages = [
      { cards: [{ id: "a" }, { id: "b" }] },
      { cards: [{ id: "b" }, { id: "c" }] }, // "b" overlaps page 1
    ];
    expect(flattenDedupe(pages, (c) => c.id).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for undefined or empty pages", () => {
    expect(flattenDedupe(undefined, (c: { id: string }) => c.id)).toEqual([]);
    expect(flattenDedupe([{ cards: [] }], (c: { id: string }) => c.id)).toEqual([]);
  });

  it("dedupes on an arbitrary key accessor (externalId)", () => {
    const pages = [
      { cards: [{ externalId: "x" }] },
      { cards: [{ externalId: "x" }, { externalId: "y" }] },
    ];
    expect(flattenDedupe(pages, (c) => c.externalId).map((c) => c.externalId)).toEqual(["x", "y"]);
  });
});

describe("getNextCursorParam", () => {
  it("returns the numeric cursor when a further page exists", () => {
    expect(getNextCursorParam({ nextCursor: 60 })).toBe(60);
    expect(getNextCursorParam({ nextCursor: 0 })).toBe(0);
  });

  it("returns undefined when there is no further page (null cursor)", () => {
    expect(getNextCursorParam({ nextCursor: null })).toBeUndefined();
  });
});
