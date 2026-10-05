/**
 * OWNER-RUN - never run by agents.
 *
 * Prints the search-benchmark fixture results for the in-process ranker.
 * With SEARCH_ENGINE=typesense (+ TYPESENSE_* env) it also prints the index's
 * top hit per query for a side-by-side engine comparison.
 *
 *   npx tsx scripts/search-benchmark.ts
 */

import fixture from "../tests/fixtures/search-benchmark.json";
import { parseSearchQuery } from "../src/lib/utils/search-query";
import { rankCards } from "../src/lib/utils/search-rank";
import { isSearchIndexEnabled, searchIndexIds } from "../src/lib/services/card-search-index.service";

type Case = { query: string; top?: string | null; topIn?: string[] };

async function main() {
  const engine = isSearchIndexEnabled();
  for (const tc of fixture.cases as Case[]) {
    const ranked = rankCards(parseSearchQuery(tc.query), fixture.cards).map((c) => c.externalId);
    const want = tc.top === undefined ? `one of ${tc.topIn?.join("|")}` : String(tc.top);
    const idx = engine ? ((await searchIndexIds({ game: "pokemon", query: tc.query }))?.[0] ?? "-") : "n/a";
    console.log(`${tc.query.padEnd(20)} want=${want.padEnd(28)} ranker=${(ranked[0] ?? "-").padEnd(10)} typesense=${idx}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
