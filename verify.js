// ============================================================
//  verify.js  —  Post-seed verification script
//  Runs a suite of SQL checks against the populated cards table
//  and reports data completeness + search speed.
//
//  Usage:  node verify.js
// ============================================================

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const c = {
  green:  (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  red:    (t) => `\x1b[31m${t}\x1b[0m`,
  cyan:   (t) => `\x1b[36m${t}\x1b[0m`,
  bold:   (t) => `\x1b[1m${t}\x1b[0m`,
  dim:    (t) => `\x1b[2m${t}\x1b[0m`,
};

function createPool() {
  return new Pool(
    process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DATABASE_URL.includes('sslmode=require')
            ? { rejectUnauthorized: false }
            : false,
        }
      : {
          host:     process.env.PGHOST     ?? 'localhost',
          port:     Number(process.env.PGPORT ?? 5432),
          database: process.env.PGDATABASE ?? 'pokemon_tcg',
          user:     process.env.PGUSER     ?? 'postgres',
          password: process.env.PGPASSWORD ?? '',
        }
  );
}

async function runVerify() {
  const pool = createPool();
  const client = await pool.connect();
  let allPassed = true;

  try {
    console.log(c.bold('\n🔍  Pokémon TCG Database Verification'));
    console.log(c.dim('─'.repeat(55)));

    // ── 1. Total row count ──────────────────────────────
    const { rows: [countRow] } = await client.query('SELECT COUNT(*) AS total FROM cards');
    const total = Number(countRow.total);
    const countPass = total >= 10_000;  // expect tens of thousands
    allPassed = allPassed && countPass;
    console.log(
      `  ${countPass ? c.green('✔') : c.red('✘')}  Total rows          : ${c.bold(total.toLocaleString())}` +
      (countPass ? '' : c.red('  ← too low!'))
    );

    // ── 2. Missing image_url ────────────────────────────
    const { rows: [noImgRow] } = await client.query(
      `SELECT COUNT(*) AS n FROM cards WHERE image_url IS NULL`
    );
    const noImg = Number(noImgRow.n);
    const imgPct = total > 0 ? ((1 - noImg / total) * 100).toFixed(1) : 0;
    const imgPass = noImg / total < 0.05;  // allow < 5% missing
    allPassed = allPassed && imgPass;
    console.log(
      `  ${imgPass ? c.green('✔') : c.yellow('⚠')}  Has image_url       : ${imgPct}%` +
      (noImg > 0 ? c.dim(` (${noImg.toLocaleString()} missing)`) : '')
    );

    // ── 3. Missing tcgplayer_price ──────────────────────
    const { rows: [noPriceRow] } = await client.query(
      `SELECT COUNT(*) AS n FROM cards WHERE tcgplayer_price IS NULL OR tcgplayer_price = 0`
    );
    const noPrice = Number(noPriceRow.n);
    const pricePct = total > 0 ? ((1 - noPrice / total) * 100).toFixed(1) : 0;
    const pricePass = noPrice / total < 0.50;  // older cards often unlisted; < 50% missing is ok
    allPassed = allPassed && pricePass;
    console.log(
      `  ${pricePass ? c.green('✔') : c.yellow('⚠')}  Has tcgplayer_price : ${pricePct}%` +
      (noPrice > 0 ? c.dim(` (${noPrice.toLocaleString()} missing)`) : '')
    );

    // ── 4. cards_complete view ──────────────────────────
    const { rows: [completeRow] } = await client.query(
      `SELECT COUNT(*) AS n FROM cards_complete`
    );
    const complete = Number(completeRow.n);
    console.log(
      `  ${c.green('✔')}  cards_complete view : ${complete.toLocaleString()} rows (image + price both present)`
    );

    // ── 5. Distinct sets ────────────────────────────────
    const { rows: [setsRow] } = await client.query(
      `SELECT COUNT(DISTINCT set_id) AS n FROM cards`
    );
    console.log(`  ${c.green('✔')}  Distinct sets       : ${setsRow.n}`);

    // ── 6. Rarity breakdown (top 5) ─────────────────────
    const { rows: rarities } = await client.query(`
      SELECT rarity, COUNT(*) AS n
      FROM   cards
      WHERE  rarity IS NOT NULL
      GROUP  BY rarity
      ORDER  BY n DESC
      LIMIT  5
    `);
    console.log(`\n  ${c.bold('Rarity breakdown (top 5):')}`);
    rarities.forEach(({ rarity, n }) =>
      console.log(`    ${c.dim('•')} ${rarity.padEnd(25)} ${Number(n).toLocaleString()}`)
    );

    // ── 7. Search speed — fuzzy name match ──────────────
    console.log(c.dim('\n─'.repeat(55)));
    console.log(`  ${c.bold('Search speed test')}  (GIN trigram index)`);

    const searchTerms = ['Pikachu', 'Charizard', 'Mewtwo', 'Eevee'];
    for (const term of searchTerms) {
      const t0 = Date.now();
      const { rows: results } = await client.query(
        `SELECT id, name, set_name, similarity(name, $1) AS score
         FROM   cards
         WHERE  name % $1
         ORDER  BY score DESC
         LIMIT  10`,
        [term]
      );
      const ms = Date.now() - t0;
      const speedPass = ms < 100;
      allPassed = allPassed && speedPass;
      console.log(
        `  ${speedPass ? c.green('✔') : c.yellow('⚠')}  "${term.padEnd(10)}" → ` +
        `${results.length} results in ${c.bold(ms + 'ms')}` +
        (speedPass ? '' : c.yellow('  ← above 100ms target'))
      );
      if (results[0]) {
        console.log(c.dim(`       Best match: ${results[0].name} (${results[0].set_name}, score ${Number(results[0].score).toFixed(3)})`));
      }
    }

    // ── 8. EXPLAIN ANALYSE for Pikachu ──────────────────
    console.log(c.dim('\n─'.repeat(55)));
    console.log(`  ${c.bold('Query plan for name % \'Pikachu\':')} (should use GIN index)\n`);
    const { rows: plan } = await client.query(`
      EXPLAIN (ANALYSE, FORMAT TEXT)
      SELECT id, name FROM cards WHERE name % 'Pikachu' ORDER BY similarity(name,'Pikachu') DESC LIMIT 10
    `);
    plan.forEach(({ 'QUERY PLAN': line }) => console.log(`  ${c.dim(line)}`));

    // ── Final verdict ───────────────────────────────────
    console.log(c.dim('\n' + '─'.repeat(55)));
    if (allPassed) {
      console.log(c.green(c.bold('  ✅  All checks passed — database is ready!')));
    } else {
      console.log(c.yellow(c.bold('  ⚠   Some checks failed — review warnings above.')));
    }
    console.log();
  } finally {
    client.release();
    await pool.end();
  }
}

runVerify().catch((err) => {
  console.error(c.red(`\n  Fatal: ${err.message}\n`));
  process.exit(1);
});
