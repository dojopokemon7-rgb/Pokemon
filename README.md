# Pokémon TCG Card Database

Full Postgres database seeded with ~40 000 Pokémon TCG cards from the [Pokémon TCG API](https://pokemontcg.io/), optimised for OCR-based fuzzy name search.

## Project Structure

```
Pokemon/
├── schema.sql      ← Run this first (once, in Postgres)
├── seed.js         ← Seeds all ~40 000 cards
├── verify.js       ← Post-seed health checks
├── package.json
├── .env.example    ← Copy to .env and fill in secrets
└── README.md
```

## Quick Start

### 1. Prerequisites
- **Node.js 18+** (`node --version`)
- **PostgreSQL 13+** with a database created
- **Pokémon TCG API key** — free at https://pokemontcg.io/

### 2. Configure environment

```powershell
Copy-Item .env.example .env
# Then edit .env with your API key and DB credentials
```

### 3. Apply the schema

```powershell
# Using psql (adjust connection flags as needed)
psql -U postgres -d pokemon_tcg -f schema.sql
```

Or paste the contents of `schema.sql` into your database GUI (pgAdmin, TablePlus, Supabase SQL editor, etc.).

### 4. Install dependencies

```powershell
npm install
```

### 5. Run the seeder

```powershell
npm run seed
```

Live progress is printed to the terminal. Expect **~10–15 minutes** for ~40 000 cards (with the default 200 ms delay). The script is **idempotent** — safe to re-run.

**Dry run** (fetch API data without writing to DB):
```powershell
npm run seed:dry
```

### 6. Verify the data

```powershell
npm run verify
```

Checks total row count, data completeness (image + price coverage), and GIN index search speed (target: < 100 ms).

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `POKEMON_TCG_API_KEY` | *(required)* | API key from pokemontcg.io |
| `DATABASE_URL` | — | Full Postgres connection string (overrides individual PG* vars) |
| `PGHOST` | `localhost` | Postgres host |
| `PGPORT` | `5432` | Postgres port |
| `PGDATABASE` | `pokemon_tcg` | Database name |
| `PGUSER` | `postgres` | Postgres user |
| `PGPASSWORD` | — | Postgres password |
| `SEED_DELAY_MS` | `200` | Delay between API pages (ms) |
| `SEED_BATCH_SIZE` | `500` | Cards per SQL INSERT |
| `SEED_MAX_RETRIES` | `3` | Retries on transient API errors |
| `DRY_RUN` | `false` | Fetch only, skip DB writes |

---

## OCR Fuzzy Search

The schema uses a **GIN trigram index** (`pg_trgm`) on the `name` column. Example query:

```sql
-- Find cards matching a potentially-misspelled OCR result
SELECT id, name, set_name, number, tcgplayer_price,
       similarity(name, 'Pikchu') AS score
FROM   cards
WHERE  name % 'Pikchu'          -- similarity threshold: 0.3 (default)
ORDER  BY score DESC
LIMIT  10;
```

To tune the threshold:
```sql
SET pg_trgm.similarity_threshold = 0.2;  -- more lenient
SET pg_trgm.similarity_threshold = 0.5;  -- stricter
```

---

## Hosted Postgres Notes

| Provider | `DATABASE_URL` suffix |
|---|---|
| **Supabase** | Add `?sslmode=require` |
| **Railway** | Add `?sslmode=require` |
| **Neon** | Add `?sslmode=require` |
| **Render** | Add `?sslmode=require` |
| **Local / Docker** | No suffix needed |
