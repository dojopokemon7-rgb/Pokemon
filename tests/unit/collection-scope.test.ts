import { describe, it, expect } from "vitest";
// F-#8 dual-scoped "All" resolver (design §4). Does not exist yet → red.
import {
  toScope,
  activeWhere,
  soldWhere,
  type CollectionScope,
} from "@/lib/utils/collection-scope";
import { ALL_VIEW_ID } from "@/lib/utils/collections-virtual";
import { ALL_COLLECTIONS } from "@/lib/utils/collection-aggregation";

const USER = "user_123";

describe("toScope — the three all-signals collapse to {kind:'all'}", () => {
  it("maps null / undefined / '' (the dashboard empty-selection signal) to all", () => {
    expect(toScope(null)).toEqual({ kind: "all" });
    expect(toScope(undefined)).toEqual({ kind: "all" });
    expect(toScope("")).toEqual({ kind: "all" });
  });

  it("maps the virtual ALL_VIEW_ID ('__all__') to all", () => {
    expect(toScope(ALL_VIEW_ID)).toEqual({ kind: "all" });
  });

  it("maps the aggregator ALL_COLLECTIONS ('all') to all", () => {
    expect(toScope(ALL_COLLECTIONS)).toEqual({ kind: "all" });
  });
});

describe("toScope — loose and specific collections", () => {
  it("maps the '__uncat__' sentinel to the loose scope", () => {
    expect(toScope("__uncat__")).toEqual({ kind: "loose" });
  });

  it("maps any other id to that collection", () => {
    expect(toScope("col_abc")).toEqual({ kind: "collection", id: "col_abc" });
  });
});

describe("activeWhere — Prisma where fragments for the ACTIVE (isSold:false) set", () => {
  it("top-level all: no collectionId key, isSold:false", () => {
    expect(activeWhere(USER, { kind: "all" })).toEqual({ userId: USER, isSold: false });
  });

  it("loose: collectionId:null, isSold:false", () => {
    expect(activeWhere(USER, { kind: "loose" })).toEqual({
      userId: USER,
      isSold: false,
      collectionId: null,
    });
  });

  it("collection: collectionId:id, isSold:false", () => {
    const scope: CollectionScope = { kind: "collection", id: "col_1" };
    expect(activeWhere(USER, scope)).toEqual({
      userId: USER,
      isSold: false,
      collectionId: "col_1",
    });
  });

  it("in-collection All == Main: same where via toScope('<id>')", () => {
    // The dual-All invariant: an in-collection "All" and "Main" resolve to the
    // IDENTICAL active where, so no caller can diverge them.
    expect(activeWhere(USER, toScope("col_1"))).toEqual({
      userId: USER,
      isSold: false,
      collectionId: "col_1",
    });
  });
});

describe("soldWhere — Prisma where fragments for the SOLD set", () => {
  it("top-level all: no collectionId key, isSold:true", () => {
    expect(soldWhere(USER, { kind: "all" })).toEqual({ userId: USER, isSold: true });
  });

  it("loose: collectionId:null, isSold:true", () => {
    expect(soldWhere(USER, { kind: "loose" })).toEqual({
      userId: USER,
      isSold: true,
      collectionId: null,
    });
  });

  it("collection: collectionId:id, isSold:true", () => {
    expect(soldWhere(USER, { kind: "collection", id: "col_1" })).toEqual({
      userId: USER,
      isSold: true,
      collectionId: "col_1",
    });
  });
});
