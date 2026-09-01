/**
 * Database Seed Script — "Local DB Cache" (Fallback 3)
 *
 * Populates `CardSet` and `Card` with a curated list of popular,
 * verified Pokémon and One Piece cards. This gives the app a
 * permanent, always-available local dataset so search/browse never
 * fully breaks if every external TCG API is down simultaneously.
 *
 * Run with:
 *   npx prisma db seed
 *
 * Idempotency:
 *   - `CardSet.externalId` and `Card.externalId` are both `@unique`.
 *   - Every write below is a Prisma `upsert`, so re-running this
 *     script never creates duplicate rows — it just refreshes the
 *     existing ones with the latest fetched data.
 *
 * Data source notes:
 *   - `searchPokemonCards` / `searchOnePieceCards` call the live
 *     fallback chain in `card.service.ts` directly (NOT the
 *     Redis-cached `searchCards()` wrapper), per the task spec.
 *     That means every run of this script performs live HTTP
 *     requests — the circuit breaker in `fallback-executor.ts`
 *     still protects against hammering a dead API, but there is no
 *     24h cache short-circuit at this layer.
 *   - `NormalizedCard` (the shape both search functions return) does
 *     not carry `hp` or `marketPrice` as schema columns — the current
 *     `Card` model has no `hp` field, and market price is populated
 *     by a separate pricing job (not part of search results). Both
 *     are therefore intentionally left untouched here rather than
 *     silently writing incorrect data.
 */

import { prisma } from "@/lib/db";
import { redis } from "@/lib/redis";
import {
  searchPokemonCards,
  searchOnePieceCards,
} from "@/lib/services/card.service";
import type { NormalizedCard } from "@/lib/validators/card.validator";

// =============================================================
// Seed Data
// =============================================================

// Pokémon: character-name queries against the Pokémon TCG API's
// `?q=name:<name>` endpoint. Each name typically returns many print
// variants (base, holo, ex, V, VMAX, etc.), so a small character list
// yields hundreds of unique cards after the per-query cap slice.
// Set names ("Evolving Skies", "Scarlet & Violet", …) are intentionally
// omitted — the Pokémon TCG API's name filter matches CARD names, not
// set names, so those searches would return zero results.
const pokemonQueries = [
  // Kanto starters + evolutions + gen-1 icons
  "Charizard", "Charmander", "Charmeleon",
  "Blastoise", "Squirtle", "Wartortle",
  "Venusaur", "Bulbasaur", "Ivysaur",
  "Pikachu", "Raichu", "Mewtwo", "Mew",
  "Gengar", "Gastly", "Haunter",
  "Snorlax", "Dragonite", "Alakazam", "Machamp", "Gyarados",
  "Lapras", "Vaporeon", "Jolteon", "Flareon", "Ninetales",
  // Eeveelutions (post-gen 1)
  "Espeon", "Umbreon", "Leafeon", "Glaceon", "Sylveon", "Eevee",
  // Legendaries
  "Lugia", "Ho-Oh", "Celebi",
  "Kyogre", "Groudon", "Rayquaza", "Deoxys",
  "Dialga", "Palkia", "Giratina", "Arceus",
  "Reshiram", "Zekrom", "Kyurem",
  "Xerneas", "Yveltal", "Zygarde",
  "Solgaleo", "Lunala", "Necrozma",
  "Zacian", "Zamazenta", "Eternatus", "Calyrex",
  "Miraidon", "Koraidon",
  // Popular non-legendary favorites
  "Garchomp", "Lucario", "Metagross", "Salamence", "Tyranitar",
  "Greninja", "Sceptile", "Blaziken", "Swampert",
  "Rowlet", "Litten", "Popplio",
  "Grookey", "Scorbunny", "Sobble",
  "Sprigatito", "Fuecoco", "Quaxly",
];

// One Piece: character-name queries against apitcg.com's `?name=<name>`
// endpoint. Each query returns ~5 real cards (plus ~20 sealed products
// that our adapter filters out), so this list of ~45 characters yields
// well over 100 unique cards after upsert deduplication.
const onePieceQueries = [
  // Straw Hat Pirates
  "Monkey D. Luffy", "Roronoa Zoro", "Nami", "Usopp", "Sanji",
  "Tony Tony Chopper", "Nico Robin", "Franky", "Brook", "Jinbe",
  // Worst Generation / Supernovas
  "Trafalgar Law", "Eustass Kid", "Killer", "Basil Hawkins",
  "Scratchmen Apoo", "X Drake", "Jewelry Bonney", "Capone Bege",
  "Urouge",
  // Yonko + top-tier
  "Shanks", "Kaido", "Charlotte Linlin", "Marshall D. Teach",
  "Edward Newgate", "Gol D. Roger", "Silvers Rayleigh",
  // Warlords / Emperors' commanders
  "Boa Hancock", "Crocodile", "Doflamingo", "Mihawk",
  "Marco", "Jozu", "Vista", "Portgas D. Ace",
  // Navy / Marines
  "Aokiji", "Akainu", "Kizaru", "Smoker", "Tashigi",
  "Coby", "Helmeppo", "Garp", "Sengoku",
  // Wano / newer arcs
  "Yamato", "Oden", "Kin'emon", "Shiryu",
  // Other iconic
  "Enel", "Rob Lucci",
];

/** Hard cap per query — bumped from 5 → 25 so a popular character like
 * Charizard contributes a full spread of print variants instead of just
 * the first five. The Pokémon TCG API and apitcg both return 25+ per
 * page by default, so this is essentially "take everything one page
 * gave us" without needing to paginate. */
const MAX_CARDS_PER_QUERY = 25;

/** Small delay between live API calls — polite to upstream sources. */
const REQUEST_DELAY_MS = 250;

type Game = "pokemon" | "onepiece";

// =============================================================
// Helpers
// =============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lowercases, strips non-alphanumerics, and hyphenates for a stable set key. */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-set";
}

/**
 * Derives an in-set card number from the normalized card id.
 *
 * Source ids typically look like `base1-4` (Pokémon TCG API) or
 * `swsh4-20` — the segment after the final hyphen is the printed
 * card number. If the id has no hyphen (e.g. mock/One Piece ids),
 * the full id is used so `number` is never empty.
 */
function deriveCardNumber(id: string): string {
  const parts = id.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : id;
}

interface SeedStats {
  cardsUpserted: number;
  setsUpserted: number;
  failures: number;
}

/** Upserts the card's parent CardSet, then the Card itself. */
async function upsertCard(
  card: NormalizedCard,
  game: Game,
  stats: SeedStats,
  seenSetExternalIds: Set<string>
): Promise<void> {
  const setName =
    card.setImage.trim() ||
    (game === "pokemon" ? "Unknown Set" : "Unknown Set (One Piece)");
  const setExternalId = `${game}-${slugify(setName)}`;

  const cardSet = await prisma.cardSet.upsert({
    where: { externalId: setExternalId },
    update: { name: setName },
    create: {
      externalId: setExternalId,
      name: setName,
    },
  });

  if (!seenSetExternalIds.has(setExternalId)) {
    seenSetExternalIds.add(setExternalId);
    stats.setsUpserted += 1;
  }

  // Persist the market price when the adapter returns one (apitcg
  // includes real TCGplayer market prices, Pokémon TCG API includes
  // TCGplayer prices for many cards). Before this line was added, the
  // seed script fetched prices from upstream and then dropped them on
  // the floor — every card in the DB had marketPrice = null even
  // though the API responses contained real numbers.
  const pricingFields =
    card.marketPrice != null
      ? { marketPrice: card.marketPrice, lastPricedAt: new Date() }
      : {};

  await prisma.card.upsert({
    where: { externalId: card.id },
    update: {
      name: card.name,
      number: deriveCardNumber(card.id),
      rarity: card.rarity,
      types: card.types,
      imageUrl: card.imageUrl,
      setId: cardSet.id,
      ...pricingFields,
    },
    create: {
      externalId: card.id,
      name: card.name,
      number: deriveCardNumber(card.id),
      rarity: card.rarity,
      types: card.types,
      imageUrl: card.imageUrl,
      setId: cardSet.id,
      ...pricingFields,
    },
  });

  stats.cardsUpserted += 1;
  console.log(`✅ Seeded: ${card.name} (${setName})`);
}

/**
 * Runs one game's query list end-to-end: fetch → slice top N → upsert each.
 * A failure on any single query or card is logged and skipped — it never
 * aborts the rest of the seed run.
 */
async function seedGame(
  queries: string[],
  game: Game,
  fetchFn: (query: string) => Promise<{ cards: NormalizedCard[] }>,
  stats: SeedStats,
  seenSetExternalIds: Set<string>
): Promise<void> {
  for (const query of queries) {
    try {
      const { cards } = await fetchFn(query);
      const topCards = cards.slice(0, MAX_CARDS_PER_QUERY);

      for (const card of topCards) {
        try {
          await upsertCard(card, game, stats, seenSetExternalIds);
        } catch (err) {
          stats.failures += 1;
          console.error(
            `❌ Failed to upsert card "${card.name}" (query="${query}"):`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      stats.failures += 1;
      console.error(
        `❌ Failed to fetch results for "${query}" (${game}):`,
        err instanceof Error ? err.message : err
      );
    }

    // Be polite to upstream APIs between queries.
    await sleep(REQUEST_DELAY_MS);
  }
}

// =============================================================
// Main
// =============================================================

async function main(): Promise<void> {
  const stats: SeedStats = { cardsUpserted: 0, setsUpserted: 0, failures: 0 };
  const seenSetExternalIds = new Set<string>();

  console.log("🌱 Seeding Pokémon cards...");
  await seedGame(
    pokemonQueries,
    "pokemon",
    searchPokemonCards,
    stats,
    seenSetExternalIds
  );

  console.log("🌊 Seeding One Piece cards...");
  await seedGame(
    onePieceQueries,
    "onepiece",
    searchOnePieceCards,
    stats,
    seenSetExternalIds
  );

  console.log(
    `🎉 Seeding complete! ${stats.cardsUpserted} cards upserted into ${stats.setsUpserted} sets` +
      (stats.failures > 0 ? ` (${stats.failures} individual failures — see logs above).` : ".")
  );
}

main()
  .catch((err) => {
    console.error("Fatal error during seeding:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    try {
      await redis.quit();
    } catch {
      // Non-fatal — process is exiting either way.
    }
  });
