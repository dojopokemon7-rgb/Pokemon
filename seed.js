// ============================================================
//  seed.js  —  Pokémon TCG Database Seeder
//  Seeds ~40 000 cards from the Pokémon TCG API into Postgres.
//
//  Usage:
//    node seed.js            — full seed
//    DRY_RUN=true node seed.js  — fetch only, no DB writes
//
//  Requirements:
//    Node >= 18  (uses native fetch)
//    PostgreSQL with schema.sql already applied
// ============================================================

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// ──────────────────────────────────────────────────────────
//  CONFIG  — all tunable via .env
// ──────────────────────────────────────────────────────────
const CONFIG = {
  apiKey:      process.env.POKEMON_TCG_API_KEY ?? '',
  apiBase:     'https://api.pokemontcg.io/v2',
  pageSize:    250,                                           // max allowed by API
  delayMs:     Number(process.env.SEED_DELAY_MS   ?? 200),   // ms between pages
  batchSize:   Number(process.env.SEED_BATCH_SIZE ?? 500),   // cards per INSERT
  maxRetries:  Number(process.env.SEED_MAX_RETRIES ?? 3),    // retries on transient errors
  dryRun:      process.env.DRY_RUN === 'true',
};

// ──────────────────────────────────────────────────────────
//  DATABASE POOL
// ──────────────────────────────────────────────────────────
function createPool() {
  // Prefer explicit DATABASE_URL; fall back to individual PGHOST etc.
  const connectionConfig = process.env.DATABASE_URL
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
      };

  return new Pool({
    ...connectionConfig,
    max:              10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

// ──────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────

/** Wait for `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pretty-print elapsed time. */
function elapsed(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** ANSI colour helpers (no extra dep). */
const c = {
  green:  (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  red:    (t) => `\x1b[31m${t}\x1b[0m`,
  cyan:   (t) => `\x1b[36m${t}\x1b[0m`,
  bold:   (t) => `\x1b[1m${t}\x1b[0m`,
  dim:    (t) => `\x1b[2m${t}\x1b[0m`,
};

// ──────────────────────────────────────────────────────────
//  API FETCHING
// ──────────────────────────────────────────────────────────

/**
 * Fetch a single page of cards from the Pokémon TCG API.
 * Retries up to CONFIG.maxRetries times on transient errors (429, 5xx).
 *
 * @param {number} page  1-based page number
 * @returns {{ data: object[], totalCount: number }}
 */
async function fetchPage(page) {
  const url = `${CONFIG.apiBase}/cards?page=${page}&pageSize=${CONFIG.pageSize}`;
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.apiKey) headers['X-Api-Key'] = CONFIG.apiKey;

  let attempt = 0;
  while (attempt <= CONFIG.maxRetries) {
    attempt++;
    try {
      const res = await fetch(url, { headers });

      // Handle rate-limit: wait and retry
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? 5);
        console.warn(c.yellow(`  ⚠  Rate limited on page ${page}. Waiting ${retryAfter}s before retry ${attempt}/${CONFIG.maxRetries}…`));
        await sleep(retryAfter * 1000);
        continue;
      }

      // Handle transient server errors
      if (res.status >= 500) {
        if (attempt > CONFIG.maxRetries) throw new Error(`HTTP ${res.status} after ${CONFIG.maxRetries} retries`);
        const backoff = attempt * 2000;
        console.warn(c.yellow(`  ⚠  HTTP ${res.status} on page ${page}. Retry ${attempt}/${CONFIG.maxRetries} in ${backoff / 1000}s…`));
        await sleep(backoff);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const json = await res.json();
      return {
        data:       json.data       ?? [],
        totalCount: json.totalCount ?? 0,
      };
    } catch (err) {
      if (attempt > CONFIG.maxRetries) throw err;
      const backoff = attempt * 1500;
      console.warn(c.yellow(`  ⚠  Network error on page ${page} (attempt ${attempt}): ${err.message}. Retrying in ${backoff / 1000}s…`));
      await sleep(backoff);
    }
  }
}

// ──────────────────────────────────────────────────────────
//  DATA MAPPING  —  API card object → DB row
// ──────────────────────────────────────────────────────────

/**
 * Map a raw Pokémon TCG API card object to a flat row for our schema.
 *
 * @param {object} card  Raw API card object
 * @returns {object}     Flat DB row
 */
function mapCard(card) {
  // Extract TCGPlayer market price (prefer "normal" printing mid price)
  let tcgplayerPrice = null;
  let tcgplayerUrl   = null;
  if (card.tcgplayer) {
    tcgplayerUrl = card.tcgplayer.url ?? null;
    const prices = card.tcgplayer.prices ?? {};
    // Priority: holofoil → reverseHolofoil → normal → 1stEdition → anything
    const priceOrder = ['holofoil', 'reverseHolofoil', 'normal', '1stEdition'];
    for (const key of priceOrder) {
      if (prices[key]?.market != null) {
        tcgplayerPrice = prices[key].market;
        break;
      }
    }
    // Fallback: grab first available market price
    if (tcgplayerPrice == null) {
      for (const priceObj of Object.values(prices)) {
        if (priceObj?.market != null) { tcgplayerPrice = priceObj.market; break; }
      }
    }
  }

  // Release date string → Date (YYYY-MM-DD)
  let releaseDate = null;
  if (card.set?.releaseDate) {
    // API returns "YYYY/MM/DD" or "MM/DD/YYYY"
    const raw = card.set.releaseDate;
    const parts = raw.split('/');
    if (parts.length === 3) {
      // Distinguish "YYYY/MM/DD" vs "MM/DD/YYYY" by length of first part
      releaseDate = parts[0].length === 4
        ? `${parts[0]}-${parts[1]}-${parts[2]}`   // YYYY/MM/DD → YYYY-MM-DD
        : `${parts[2]}-${parts[0]}-${parts[1]}`;  // MM/DD/YYYY → YYYY-MM-DD
    }
  }

  return {
    id:              card.id,
    name:            card.name,
    set_id:          card.set?.id          ?? '',
    set_name:        card.set?.name        ?? '',
    series:          card.set?.series      ?? null,
    number:          card.number           ?? '',
    rarity:          card.rarity           ?? null,
    supertype:       card.supertype        ?? null,
    subtypes:        card.subtypes         ?? [],
    image_url:       card.images?.large    ?? null,
    image_url_small: card.images?.small    ?? null,
    tcgplayer_price: tcgplayerPrice,
    tcgplayer_url:   tcgplayerUrl,
    hp:              card.hp ? Number(card.hp) : null,
    artist:          card.artist           ?? null,
    release_date:    releaseDate,
    legalities:      card.legalities       ?? null,
    raw_data:        card,                                // store full payload
  };
}

// ──────────────────────────────────────────────────────────
//  BATCH UPSERT
// ──────────────────────────────────────────────────────────

/**
 * Upsert a batch of mapped card rows into the database.
 * Uses ON CONFLICT (id) DO UPDATE so the script is idempotent.
 *
 * @param {pg.PoolClient} client  DB client
 * @param {object[]}      rows    Array of mapped card rows
 * @returns {number}              Number of rows affected
 */
async function upsertBatch(client, rows) {
  if (rows.length === 0) return 0;

  // Build parameterised query dynamically for the batch
  // Column order must match the VALUES placeholders below.
  const COLUMNS = [
    'id', 'name', 'set_id', 'set_name', 'series',
    'number', 'rarity', 'supertype', 'subtypes',
    'image_url', 'image_url_small', 'tcgplayer_price', 'tcgplayer_url',
    'hp', 'artist', 'release_date', 'legalities', 'raw_data',
  ];

  const NUM_COLS = COLUMNS.length;
  const values   = [];
  const placeholders = rows.map((row, rowIdx) => {
    const rowPlaceholders = COLUMNS.map((col, colIdx) => {
      const paramIdx = rowIdx * NUM_COLS + colIdx + 1;
      let val = row[col];

      // pg driver needs JS arrays for TEXT[] columns
      // and plain JS objects / null for JSONB
      values.push(val ?? null);
      return `$${paramIdx}`;
    });
    return `(${rowPlaceholders.join(', ')})`;
  });

  // ON CONFLICT: update every column except id & created_at
  const updateClauses = COLUMNS
    .filter((col) => col !== 'id')
    .map((col) => `${col} = EXCLUDED.${col}`)
    .join(',\n        ');

  const sql = `
    INSERT INTO cards (${COLUMNS.join(', ')})
    VALUES ${placeholders.join(',\n    ')}
    ON CONFLICT (id) DO UPDATE SET
        ${updateClauses},
        updated_at = NOW()
  `;

  const result = await client.query(sql, values);
  return result.rowCount ?? rows.length;
}

// ──────────────────────────────────────────────────────────
//  MAIN SEED RUNNER
// ──────────────────────────────────────────────────────────

async function runSeed() {
  const startMs = Date.now();

  console.log(c.bold('\n🃏  Pokémon TCG Database Seeder'));
  console.log(c.dim('─'.repeat(50)));
  if (CONFIG.dryRun) console.log(c.yellow('  DRY RUN mode — no database writes\n'));
  if (!CONFIG.apiKey) console.log(c.yellow('  ⚠  No API key set. Rate limits will be low.\n'));

  // ── Stats tracking ──────────────────────────────────────
  const stats = {
    totalFetched:  0,
    totalInserted: 0,
    totalSkipped:  0,   // rows with no id (defensive)
    pageErrors:    [],  // pages that failed after all retries
  };

  // ── DB pool ─────────────────────────────────────────────
  const pool = createPool();

  if (!CONFIG.dryRun) {
    // Quick connectivity check
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log(c.green('  ✔  Database connection established'));
    } catch (err) {
      console.error(c.red(`  ✘  Cannot connect to database: ${err.message}`));
      console.error(c.dim('     Check your .env and make sure schema.sql has been applied.'));
      process.exit(1);
    }
  }

  // ── Determine total pages ───────────────────────────────
  console.log(`\n  Fetching page 1 to determine total card count…`);
  let totalCards  = 0;
  let totalPages  = 0;
  let firstPage;

  try {
    firstPage  = await fetchPage(1);
    totalCards = firstPage.totalCount;
    totalPages = Math.ceil(totalCards / CONFIG.pageSize);
    console.log(c.cyan(`  📦  Total cards in API : ${totalCards.toLocaleString()}`));
    console.log(c.cyan(`  📄  Pages to fetch     : ${totalPages} (${CONFIG.pageSize} per page)`));
    console.log(c.cyan(`  ⏱   Est. time          : ~${Math.ceil((totalPages * CONFIG.delayMs) / 60_000)} min`));
    console.log(c.dim('─'.repeat(50)));
  } catch (err) {
    console.error(c.red(`  ✘  Failed to fetch page 1: ${err.message}`));
    await pool.end();
    process.exit(1);
  }

  // ── Process all pages ───────────────────────────────────
  let cardBuffer = [];  // accumulates mapped rows across pages

  async function flushBuffer(client, force = false) {
    if (cardBuffer.length === 0) return;
    if (!force && cardBuffer.length < CONFIG.batchSize) return;

    // Split buffer into chunks of batchSize and insert each
    while (cardBuffer.length >= CONFIG.batchSize || (force && cardBuffer.length > 0)) {
      const chunk = cardBuffer.splice(0, CONFIG.batchSize);
      if (CONFIG.dryRun) {
        stats.totalInserted += chunk.length;
      } else {
        const inserted = await upsertBatch(client, chunk);
        stats.totalInserted += inserted;
      }
    }
  }

  const client = CONFIG.dryRun ? null : await pool.connect();

  try {
    // Process the first page we already fetched
    const pages = [{ pageNum: 1, pageData: firstPage }];

    // Iterate remaining pages
    for (let page = 2; page <= totalPages; page++) {
      await sleep(CONFIG.delayMs);

      let pageData;
      try {
        pageData = await fetchPage(page);
      } catch (err) {
        console.error(c.red(`  ✘  Page ${page} failed after ${CONFIG.maxRetries} retries: ${err.message}`));
        stats.pageErrors.push({ page, error: err.message });
        continue;  // ← skip this page, don't abort the whole run
      }

      pages.push({ pageNum: page, pageData });

      // Process the previous page's batch once we know next page exists
      if (pages.length >= 2) {
        const { pageNum, pageData: pd } = pages.shift();
        await processPage(pageNum, pd);
      }
    }

    // Drain remaining pages
    for (const { pageNum, pageData: pd } of pages) {
      await processPage(pageNum, pd);
    }

    // Final flush
    if (!CONFIG.dryRun && client) {
      await flushBuffer(client, true);
    } else {
      await flushBuffer(null, true);
    }
  } finally {
    if (client) client.release();
    await pool.end();
  }

  // ── Print summary ────────────────────────────────────────
  printSummary(stats, totalCards, startMs);

  // ── Local helper: process one page ──────────────────────
  async function processPage(pageNum, pageData) {
    const { data } = pageData;
    if (!data || data.length === 0) return;

    stats.totalFetched += data.length;

    // Map and filter out any cards without an id
    const mapped = data.map(mapCard).filter((row) => {
      if (!row.id) { stats.totalSkipped++; return false; }
      return true;
    });

    cardBuffer.push(...mapped);

    // Progress log
    const pct = ((pageNum / totalPages) * 100).toFixed(1);
    process.stdout.write(
      `\r  Page ${String(pageNum).padStart(4)}/${totalPages} │ ` +
      `fetched ${stats.totalFetched.toLocaleString().padStart(6)} │ ` +
      `inserted ${stats.totalInserted.toLocaleString().padStart(6)} │ ` +
      `${pct}% │ ${elapsed(startMs)}   `
    );

    // Flush if buffer has enough for a full batch
    if (!CONFIG.dryRun && client) {
      await flushBuffer(client, false);
    } else if (CONFIG.dryRun && cardBuffer.length >= CONFIG.batchSize) {
      await flushBuffer(null, false);
    }
  }
}

// ──────────────────────────────────────────────────────────
//  SUMMARY REPORT
// ──────────────────────────────────────────────────────────

function printSummary(stats, totalCards, startMs) {
  console.log('\n');
  console.log(c.bold('  ═══════════════════ SEED COMPLETE ═══════════════════'));
  console.log(`  ${c.green('Total fetched')}   : ${stats.totalFetched.toLocaleString()} / ${totalCards.toLocaleString()} cards`);
  console.log(`  ${c.green('Total inserted')}  : ${stats.totalInserted.toLocaleString()} rows (upserted)`);
  if (stats.totalSkipped > 0)
    console.log(`  ${c.yellow('Skipped')}         : ${stats.totalSkipped} cards (missing id)`);
  if (stats.pageErrors.length > 0) {
    console.log(`  ${c.red('Page errors')}     : ${stats.pageErrors.length} page(s) failed:`);
    stats.pageErrors.forEach(({ page, error }) =>
      console.log(c.dim(`    • Page ${page}: ${error}`))
    );
  } else {
    console.log(`  ${c.green('Page errors')}     : none 🎉`);
  }
  console.log(`  ${c.cyan('Elapsed time')}    : ${elapsed(startMs)}`);
  console.log(c.bold('  ═══════════════════════════════════════════════════'));

  if (!CONFIG.dryRun) {
    console.log(c.dim('\n  Run verify.js to confirm row counts and search speed.\n'));
  }
}

// ──────────────────────────────────────────────────────────
//  ENTRY POINT
// ──────────────────────────────────────────────────────────
runSeed().catch((err) => {
  console.error(c.red(`\n  Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
