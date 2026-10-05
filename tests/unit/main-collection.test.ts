import { describe, it, expect } from "vitest";
import { isMainCollectionName, MAIN_COLLECTION_NAME } from "@/lib/utils/main-collection";
import { shouldShowUncategorized, defaultSelectorIds } from "@/lib/utils/collection-ids";

describe("isMainCollectionName", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(MAIN_COLLECTION_NAME).toBe("Main");
    for (const n of ["Main", " main ", "MAIN", "mAiN"]) expect(isMainCollectionName(n)).toBe(true);
  });
  it("rejects other names and nullish", () => {
    for (const n of ["Mainline", "Ma in", "", null, undefined]) expect(isMainCollectionName(n)).toBe(false);
  });
});

describe("shouldShowUncategorized", () => {
  it("is true only when some lot (active or sold) has a null collectionId", () => {
    expect(shouldShowUncategorized([])).toBe(false);
    expect(shouldShowUncategorized([{ collectionId: "a" }])).toBe(false);
    expect(shouldShowUncategorized([{ collectionId: "a" }, { collectionId: null }])).toBe(true);
    expect(shouldShowUncategorized([{ collectionId: undefined }])).toBe(true);
  });
});

describe("defaultSelectorIds (SSR/client byte-identity)", () => {
  it("puts __uncat__ first only when shown, then named ids in order", () => {
    expect(defaultSelectorIds(["a", "b"], [{ collectionId: null }])).toEqual(["__uncat__", "a", "b"]);
    expect(defaultSelectorIds(["a", "b"], [{ collectionId: "a" }])).toEqual(["a", "b"]);
  });
});
