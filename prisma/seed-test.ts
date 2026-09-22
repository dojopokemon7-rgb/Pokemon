/**
 * Deterministic TEST seed — fixtures for local dev + the test harness.
 *
 * DISTINCT from `prisma/seed.ts` (the production "local DB cache" fallback
 * that hits live TCG APIs). This one makes NO network calls: it generates a
 * fixed, reproducible dataset so tests assert against known values.
 *
 * Loads:
 *   - 3 test users (test1/2/3@example.com), one flagged isAdmin.
 *   - 200 mock cards: ~half Pokémon, ~half One Piece, a deterministic
 *     mix of graded and ungraded.
 *   - golden_prices.json (READ-ONLY) is only *read* for a sanity log — it
 *     is NEVER written to by this script.
 *
 * Idempotent: every write is an upsert keyed on a unique field, so re-running
 * refreshes rather than duplicates.
 *
 * Run with:  npm run seed
 *
 * ---------------------------------------------------------------------------
 * GRADING CAVEAT
 * ---------------------------------------------------------------------------
 * The current Prisma schema has NO `grade` column on Card or UserCollection.
 * A card's graded-ness is therefore encoded in fields that DO exist:
 *   - graded cards get `rarity = "PSA <n>"` and a `gradeMultiplier`-inflated
 *     marketPrice (a raw NM card graded PSA 10 is worth more).
 *   - the owning collection row records the grade in `condition` ("PSA 10").
 * When a real `grade` column is added later, migrate these off `rarity`.
 * Marked here rather than silently altering the schema in a setup-only task.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { redis } from "@/lib/redis";

// ---------------------------------------------------------------------------
// Deterministic PRNG — a seeded generator so every run produces the SAME
// dataset (tests can hard-code expected values). Mulberry32: tiny, fast,
// good enough for fixture generation (NOT for anything security-sensitive).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x743); // fixed seed → reproducible fixtures
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TOTAL_CARDS = 200;
const POKEMON_COUNT = 100; // remaining 100 are One Piece
const GOLDEN_PRICES_PATH = join(process.cwd(), "tests", "fixtures", "golden_prices.json");

const POKEMON_NAMES = [
  "Charizard", "Pikachu", "Blastoise", "Venusaur", "Mewtwo", "Mew", "Gengar",
  "Snorlax", "Dragonite", "Gyarados", "Umbreon", "Sylveon", "Rayquaza",
  "Lugia", "Arceus", "Garchomp", "Lucario", "Greninja", "Zacian", "Miraidon",
] as const;
const ONE_PIECE_NAMES = [
  "Monkey D. Luffy", "Roronoa Zoro", "Nami", "Sanji", "Nico Robin",
  "Trafalgar Law", "Eustass Kid", "Shanks", "Kaido", "Charlotte Linlin",
  "Boa Hancock", "Crocodile", "Doflamingo", "Mihawk", "Portgas D. Ace",
  "Yamato", "Marco", "Sabo", "Gol D. Roger", "Marshall D. Teach",
] as const;

const POKEMON_RARITIES = ["Common", "Uncommon", "Rare", "Rare Holo", "Ultra Rare", "Secret Rare"] as const;
const OP_RARITIES = ["C", "UC", "R", "SR", "SEC", "L"] as const;
const POKEMON_TYPES = ["Fire", "Water", "Grass", "Lightning", "Psychic", "Fighting", "Dark", "Dragon"] as const;
const OP_TYPES = ["Red", "Green", "Blue", "Purple", "Black", "Yellow"] as const;
const PSA_GRADES = [8, 9, 10] as const;

type Game = "pokemon" | "onepiece";

interface MockCard {
  externalId: string;
  name: string;
  number: string;
  rarity: string;
  types: string[];
  imageUrl: string;
  marketPrice: number;
  graded: boolean;
  grade: number | null;
  setExternalId: string;
  setName: string;
}

/** Grade → market-price multiplier. A PSA 10 commands a big premium. */
function gradeMultiplier(grade: number): number {
  return grade === 10 ? 4 : grade === 9 ? 2 : 1.3;
}

function buildCard(i: number, game: Game): MockCard {
  const names = game === "pokemon" ? POKEMON_NAMES : ONE_PIECE_NAMES;
  const types = game === "pokemon" ? POKEMON_TYPES : OP_TYPES;
  const name = pick(names);
  // Deterministic graded/ungraded split: every 3rd card is graded.
  const graded = i % 3 === 0;
  const grade = graded ? pick(PSA_GRADES) : null;

  const basePrice = Math.round((5 + rand() * 495) * 100) / 100; // $5–$500
  const marketPrice = graded
    ? Math.round(basePrice * gradeMultiplier(grade!) * 100) / 100
    : basePrice;

  const setName =
    game === "pokemon"
      ? pick(["Base Set", "Evolving Skies", "Scarlet & Violet", "151"])
      : pick(["Romance Dawn", "Paramount War", "Pillars of Strength", "Kingdoms of Intrigue"]);

  return {
    externalId: `test-${game}-${i}`,
    name,
    number: `${i}/200`,
    // Graded-ness encoded in rarity (no grade column — see header caveat).
    rarity: graded ? `PSA ${grade}` : pick(game === "pokemon" ? POKEMON_RARITIES : OP_RARITIES),
    types: [pick(types)],
    imageUrl: `https://example.test/${game}/${i}.png`,
    marketPrice,
    graded,
    grade,
    setExternalId: `test-${game}-${setName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    setName,
  };
}

function buildAllCards(): MockCard[] {
  const cards: MockCard[] = [];
  for (let i = 0; i < TOTAL_CARDS; i++) {
    cards.push(buildCard(i, i < POKEMON_COUNT ? "pokemon" : "onepiece"));
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Seed steps
// ---------------------------------------------------------------------------
const TEST_USERS = [
  { email: "test1@example.com", name: "Test User One", isAdmin: false },
  { email: "test2@example.com", name: "Test User Two", isAdmin: false },
  { email: "test3@example.com", name: "Test Admin", isAdmin: true },
];

async function seedUsers(): Promise<string[]> {
  const ids: string[] = [];
  for (const u of TEST_USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, isAdmin: u.isAdmin, emailVerified: true },
      create: { email: u.email, name: u.name, isAdmin: u.isAdmin, emailVerified: true },
    });
    ids.push(user.id);
    console.log(`👤 User: ${u.email}${u.isAdmin ? " (admin)" : ""}`);
  }
  return ids;
}

async function seedCards(cards: MockCard[]): Promise<void> {
  const seenSets = new Set<string>();
  for (const c of cards) {
    if (!seenSets.has(c.setExternalId)) {
      await prisma.cardSet.upsert({
        where: { externalId: c.setExternalId },
        update: { name: c.setName },
        create: { externalId: c.setExternalId, name: c.setName },
      });
      seenSets.add(c.setExternalId);
    }
    const set = await prisma.cardSet.findUniqueOrThrow({ where: { externalId: c.setExternalId } });
    await prisma.card.upsert({
      where: { externalId: c.externalId },
      update: {
        name: c.name, number: c.number, rarity: c.rarity, types: c.types,
        imageUrl: c.imageUrl, setId: set.id, marketPrice: c.marketPrice, lastPricedAt: new Date(),
      },
      create: {
        externalId: c.externalId, name: c.name, number: c.number, rarity: c.rarity,
        types: c.types, imageUrl: c.imageUrl, setId: set.id, marketPrice: c.marketPrice, lastPricedAt: new Date(),
      },
    });
  }
  const graded = cards.filter((c) => c.graded).length;
  console.log(`🃏 Cards: ${cards.length} (${graded} graded, ${cards.length - graded} ungraded)`);
}

/** READ-ONLY sanity check of golden_prices.json. Never writes to it. */
function readGoldenPrices(): void {
  try {
    const raw = readFileSync(GOLDEN_PRICES_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown[];
    console.log(`📄 golden_prices.json present: ${parsed.length} entries (read-only, untouched)`);
  } catch {
    console.log(
      `📄 golden_prices.json not found at ${GOLDEN_PRICES_PATH} — ` +
        `drop the provided READ-ONLY file there. Seed does not create it.`
    );
  }
}

async function main(): Promise<void> {
  console.log("🌱 Test seed starting (deterministic, no network)…");
  await seedUsers();
  await seedCards(buildAllCards());
  readGoldenPrices();
  console.log("🎉 Test seed complete.");
}

main()
  .catch((err) => {
    console.error("Fatal error during test seed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    try {
      await redis.quit();
    } catch {
      /* process exiting anyway */
    }
  });
