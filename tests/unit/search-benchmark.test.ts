import { describe, it, expect } from "vitest";
import fixture from "../fixtures/search-benchmark.json";
import { parseSearchQuery } from "@/lib/utils/search-query";
import { rankCards } from "@/lib/utils/search-rank";

type Case = { query: string; top?: string | null; topIn?: string[]; exclude?: string[] };

describe("search benchmark fixture", () => {
  for (const tc of fixture.cases as Case[]) {
    it(`"${tc.query}"`, () => {
      const out = rankCards(parseSearchQuery(tc.query), fixture.cards).map((c) => c.externalId);
      if (tc.top === null) expect(out).toEqual([]);
      if (tc.top) expect(out[0]).toBe(tc.top);
      if (tc.topIn) expect(tc.topIn).toContain(out[0]);
      for (const x of tc.exclude ?? []) expect(out).not.toContain(x);
    });
  }
});
