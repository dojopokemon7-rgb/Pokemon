/**
 * OWNER-RUN - never run by agents.
 *
 * Idempotent backfill of the Typesense `cards` collection from PostgreSQL.
 * The index is a rebuildable projection; Postgres stays the source of truth.
 *
 * Usage:
 *   npx tsx scripts/backfill-search-index.ts           # dry run (counts only)
 *   npx tsx scripts/backfill-search-index.ts --apply   # create schema + upsert
 *
 * Env: TYPESENSE_URL, TYPESENSE_ADMIN_API_KEY (admin key, never the search key),
 *      TYPESENSE_COLLECTION (default "cards").
 */

import { prisma } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");
const PAGE = 500;
const URL_ = process.env.TYPESENSE_URL;
const KEY = process.env.TYPESENSE_ADMIN_API_KEY;
const COLLECTION = process.env.TYPESENSE_COLLECTION || "cards";

async function ts(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, URL_), {
    ...init,
    headers: { "X-TYPESENSE-API-KEY": KEY as string, ...(init.headers ?? {}) },
  });
}

async function ensureCollection() {
  if ((await ts(`/collections/${COLLECTION}`)).ok) return;
  const res = await ts("/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: COLLECTION,
      fields: [
        { name: "externalId", type: "string" },
        { name: "name", type: "string" },
        { name: "number", type: "string", optional: true },
        { name: "setName", type: "string", facet: true },
        { name: "rarity", type: "string", optional: true, facet: true },
        { name: "game", type: "string", facet: true },
        { name: "marketPrice", type: "float", optional: true },
        { name: "tags", type: "string[]", optional: true },
      ],
    }),
  });
  if (!res.ok) throw new Error(`create collection failed: ${res.status}`);
}

async function main() {
  if (APPLY && (!URL_ || !KEY)) throw new Error("TYPESENSE_URL and TYPESENSE_ADMIN_API_KEY are required for --apply");
  if (APPLY) await ensureCollection();

  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const cards = await prisma.card.findMany({
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true, externalId: true, name: true, number: true, rarity: true, marketPrice: true, tags: true,
        set: { select: { name: true, externalId: true } },
      },
    });
    if (cards.length === 0) break;
    cursor = cards[cards.length - 1].id;
    total += cards.length;

    if (APPLY) {
      const jsonl = cards
        .map((c) =>
          JSON.stringify({
            id: c.externalId, // id = externalId → re-runs upsert, never duplicate
            externalId: c.externalId,
            name: c.name,
            ...(c.number ? { number: c.number } : {}),
            setName: c.set?.name ?? "",
            ...(c.rarity ? { rarity: c.rarity } : {}),
            game: c.set?.externalId.startsWith("onepiece-") ? "onepiece" : "pokemon",
            ...(c.marketPrice != null ? { marketPrice: c.marketPrice } : {}),
            tags: c.tags ?? [],
          })
        )
        .join("\n");
      const res = await ts(`/collections/${COLLECTION}/documents/import?action=upsert`, { method: "POST", body: jsonl });
      if (!res.ok) throw new Error(`import failed: ${res.status}`);
    }
    console.log(`${APPLY ? "upserted" : "would upsert"} ${total} so far`);
  }
  console.log(`${APPLY ? "Done" : "Dry run"}: ${total} cards. ${APPLY ? "" : "Re-run with --apply to write."}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
