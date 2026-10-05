/**
 * Optional Typesense search adapter (Epic A). SERVER-ONLY: reads the search
 * key from env; never import from client code.
 *
 * Disabled unless SEARCH_ENGINE=typesense AND TYPESENSE_URL + the search-only
 * key are set. It returns ONLY ordered `externalId`s — the route hydrates rows
 * from PostgreSQL with the same filters, so Postgres stays the source of
 * truth. Any failure (timeout, non-2xx, malformed payload) returns `null`
 * and the route falls back to the Postgres path. Identifier-shaped queries
 * are never sent (exact ids must not be typo-matched).
 */

import { z } from "zod";
import { parseSearchQuery } from "@/lib/utils/search-query";

export interface SearchIndexParams {
  game: "pokemon" | "onepiece";
  query: string;
  set?: string;
  rarity?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
}

const HitsSchema = z.object({
  hits: z.array(z.object({ document: z.object({ externalId: z.string().min(1) }) })),
});

export function isSearchIndexEnabled(): boolean {
  return (
    process.env.SEARCH_ENGINE === "typesense" &&
    !!process.env.TYPESENSE_URL &&
    !!process.env.TYPESENSE_SEARCH_API_KEY
  );
}

/** Backtick-quote a filter value (Typesense literal); strips embedded backticks. */
const lit = (v: string) => `\`${v.replace(/`/g, "")}\``;

export async function searchIndexIds(p: SearchIndexParams): Promise<string[] | null> {
  if (!isSearchIndexEnabled() || parseSearchQuery(p.query).identifierLike) return null;

  const filters = [`game:=${p.game}`];
  if (p.set) filters.push(`setName:=${lit(p.set)}`);
  if (p.rarity) filters.push(`rarity:=${lit(p.rarity)}`);
  if (p.minPrice != null) filters.push(`marketPrice:>=${p.minPrice}`);
  if (p.maxPrice != null) filters.push(`marketPrice:<=${p.maxPrice}`);

  const url = new URL(
    `/collections/${encodeURIComponent(process.env.TYPESENSE_COLLECTION || "cards")}/documents/search`,
    process.env.TYPESENSE_URL
  );
  url.searchParams.set("q", p.query);
  url.searchParams.set("query_by", "name,setName,number,externalId");
  url.searchParams.set("query_by_weights", "4,2,3,5");
  url.searchParams.set("num_typos", "1,1,0,0");
  url.searchParams.set("prefix", "true");
  url.searchParams.set("filter_by", filters.join(" && "));
  url.searchParams.set("per_page", String(p.limit ?? 60));
  url.searchParams.set("include_fields", "externalId");

  const timeoutMs = Number(process.env.TYPESENSE_TIMEOUT_MS) || 1500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      headers: { "X-TYPESENSE-API-KEY": process.env.TYPESENSE_SEARCH_API_KEY as string },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const parsed = HitsSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.hits.map((h) => h.document.externalId) : null;
  } catch {
    // Never log the key; the failure is non-fatal (Postgres fallback).
    return null;
  } finally {
    clearTimeout(timer);
  }
}
