/**
 * seed_portfolio.js
 * ─────────────────────────────────────────────────────────────
 * Task 2.5 – Demo User & Portfolio Seeding
 *
 * Creates the demo user 'demo-user-001' and seeds 15 high-value
 * Pokémon TCG cards into their portfolio.
 *
 * Usage:
 *   node seed_portfolio.js
 *
 * Requires: .env with PGPASSWORD / DATABASE_URL set (same as seed.js)
 * ─────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// ── DB connection ─────────────────────────────────────────────
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.PGHOST     || 'localhost',
        port:     Number(process.env.PGPORT) || 5432,
        database: process.env.PGDATABASE || 'pokemon_tcg',
        user:     process.env.PGUSER     || 'postgres',
        password: process.env.PGPASSWORD,
      }
);

// ── Demo user ─────────────────────────────────────────────────
const DEMO_USER = {
  id:    'demo-user-001',
  name:  'Demo Collector',
  email: 'demo@tcgplatform.com',
};

// ── 15 Demo portfolio cards ───────────────────────────────────
// Selected by card_id (verified against live DB).
// purchase_price reflects approximate market value (USD) for realism.
const DEMO_PORTFOLIO = [
  // ① Charizard VMAX – Darkness Ablaze (the iconic one)
  { card_id: 'swsh3-20',        quantity: 1, purchase_price: 45.00 },

  // ② Pikachu V – Vivid Voltage (full-art)
  { card_id: 'swsh4-170',       quantity: 2, purchase_price: 18.50 },

  // ③ Mewtwo-EX – Next Destinies (classic chase card)
  { card_id: 'bw4-98',          quantity: 1, purchase_price: 55.00 },

  // ④ Umbreon VMAX – Evolving Skies (alt-art, most valuable ES card)
  { card_id: 'swsh7-215',       quantity: 1, purchase_price: 180.00 },

  // ⑤ Rayquaza VMAX – Evolving Skies (alt-art)
  { card_id: 'swsh7-218',       quantity: 1, purchase_price: 95.00 },

  // ⑥ Lugia VSTAR – Silver Tempest (alt-art)
  { card_id: 'swsh12-211',      quantity: 1, purchase_price: 120.00 },

  // ⑦ Giratina VSTAR – Lost Origin (alt-art)
  { card_id: 'swsh11-212',      quantity: 1, purchase_price: 75.00 },

  // ⑧ Arceus VSTAR – Brilliant Stars
  { card_id: 'swsh9-157',       quantity: 1, purchase_price: 28.00 },

  // ⑨ Eevee V – SWSH Black Star Promos (fan-favourite)
  { card_id: 'swshp-SWSH065',   quantity: 3, purchase_price: 12.00 },

  // ⑩ Gengar VMAX – Fusion Strike (alt-art)
  { card_id: 'swsh8-271',       quantity: 1, purchase_price: 65.00 },

  // ⑪ Mew VMAX – Fusion Strike (alt-art)
  { card_id: 'swsh8-269',       quantity: 1, purchase_price: 85.00 },

  // ⑫ Charizard ex – Obsidian Flames (special illustration rare)
  { card_id: 'sv3-228',         quantity: 1, purchase_price: 110.00 },

  // ⑬ Darkrai VSTAR – Astral Radiance
  { card_id: 'swsh10-99',       quantity: 2, purchase_price: 20.00 },

  // ⑭ Espeon VMAX – Evolving Skies (alt-art)
  { card_id: 'swsh7-65',        quantity: 1, purchase_price: 60.00 },

  // ⑮ Sylveon VMAX – Evolving Skies (alt-art)
  { card_id: 'swsh7-75',        quantity: 1, purchase_price: 70.00 },
];

// ── Helpers ───────────────────────────────────────────────────
const hr  = '─'.repeat(56);
const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2 });

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🃏  Demo Portfolio Seeder');
  console.log(hr);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Step 1: Upsert demo user ──────────────────────────────
    console.log('\n  👤  Upserting demo user…');
    await client.query(
      `INSERT INTO users (id, name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET name  = EXCLUDED.name,
             email = EXCLUDED.email`,
      [DEMO_USER.id, DEMO_USER.name, DEMO_USER.email]
    );
    console.log(`  ✔  User "${DEMO_USER.name}" (${DEMO_USER.id}) ready`);

    // ── Step 2: Verify all card IDs exist in DB ───────────────
    console.log('\n  🔍  Verifying card IDs against cards table…');
    const cardIds = DEMO_PORTFOLIO.map(p => p.card_id);
    const { rows: foundCards } = await client.query(
      `SELECT id, name, set_name FROM cards WHERE id = ANY($1::text[])`,
      [cardIds]
    );

    const foundSet = new Map(foundCards.map(r => [r.id, r]));
    const missing  = cardIds.filter(id => !foundSet.has(id));

    if (missing.length > 0) {
      throw new Error(
        `The following card IDs were not found in the database:\n  ${missing.join('\n  ')}\n` +
        `Re-run seed.js first, or update the card IDs in seed_portfolio.js.`
      );
    }
    console.log(`  ✔  All ${cardIds.length} card IDs verified`);

    // ── Step 3: Upsert portfolio rows ─────────────────────────
    console.log('\n  📦  Inserting portfolio entries…\n');

    let totalValue = 0;
    for (const entry of DEMO_PORTFOLIO) {
      const card = foundSet.get(entry.card_id);
      const lineValue = (entry.purchase_price ?? 0) * entry.quantity;
      totalValue += lineValue;

      await client.query(
        `INSERT INTO user_portfolios (user_id, card_id, quantity, purchase_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, card_id) DO UPDATE
           SET quantity       = EXCLUDED.quantity,
               purchase_price = EXCLUDED.purchase_price,
               added_at       = NOW()`,
        [DEMO_USER.id, entry.card_id, entry.quantity, entry.purchase_price ?? null]
      );

      console.log(
        `  ✔  ${card.name.padEnd(26)} │ ${card.set_name.padEnd(28)} │ qty ${entry.quantity} │ $${fmt(entry.purchase_price ?? 0)}`
      );
    }

    await client.query('COMMIT');

    // ── Step 4: Summary ───────────────────────────────────────
    const { rows: [{ count }] } = await client.query(
      `SELECT COUNT(*) FROM user_portfolios WHERE user_id = $1`,
      [DEMO_USER.id]
    );

    console.log(`\n${hr}`);
    console.log(`  ✅  Seeding complete!`);
    console.log(`  Portfolio size : ${count} cards`);
    console.log(`  Total value    : $${fmt(totalValue)}`);
    console.log(hr);

    // ── Step 5: Print the verification query result ───────────
    console.log('\n  📋  Verification query result:');
    console.log('  SELECT c.name FROM user_portfolios up JOIN cards c ON up.card_id = c.id');
    console.log(`  WHERE up.user_id = '${DEMO_USER.id}';\n`);

    const { rows: verifyRows } = await client.query(
      `SELECT c.name, c.set_name, up.quantity, up.purchase_price
       FROM   user_portfolios up
       JOIN   cards c ON up.card_id = c.id
       WHERE  up.user_id = $1
       ORDER  BY up.added_at`,
      [DEMO_USER.id]
    );

    verifyRows.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(2, '0')}. ${r.name.padEnd(26)} │ ${r.set_name.padEnd(28)} │ qty ${r.quantity}`
      );
    });

    console.log(`\n  → ${verifyRows.length} rows returned (expected: 15)\n`);

    if (verifyRows.length !== 15) {
      console.warn('  ⚠  Row count is not 15 — check for conflicts or missing cards.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n  ✘  Error (rolled back):', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
