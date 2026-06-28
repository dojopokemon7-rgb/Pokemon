-- ============================================================
--  Pokémon TCG Card Database Schema
--  Optimised for:
--    • Full-text / fuzzy name search (OCR matching)
--    • High-volume reads across 40 000+ rows
--    • Fast set / rarity filtering
-- ============================================================

-- Enable the pg_trgm extension so we can build a GIN trigram
-- index for fuzzy LIKE / ILIKE / similarity queries.
-- (Requires PostgreSQL 9.1+; already bundled in most managed
--  Postgres services such as Supabase, Railway, Render, etc.)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ────────────────────────────────────────────────────────────
--  Main cards table
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cards (
    -- Primary key: the canonical API id  (e.g. "xy7-54", "sv3pt5-181")
    id               VARCHAR(64)    PRIMARY KEY,

    -- Human-readable card name  (e.g. "Pikachu", "Charizard ex")
    name             VARCHAR(255)   NOT NULL,

    -- Set information
    set_id           VARCHAR(32)    NOT NULL,               -- e.g. "sv3pt5"
    set_name         VARCHAR(255)   NOT NULL,               -- e.g. "151"
    series           VARCHAR(128),                          -- e.g. "Scarlet & Violet"

    -- Collector / print details
    number           VARCHAR(16)    NOT NULL,               -- e.g. "074/189"
    rarity           VARCHAR(64),                           -- e.g. "Double Rare"
    supertype        VARCHAR(32),                           -- Pokémon | Trainer | Energy
    subtypes         TEXT[],                                -- e.g. ARRAY['Basic','V']

    -- Imagery
    image_url        VARCHAR(512),                          -- hi-res card image
    image_url_small  VARCHAR(512),                          -- thumbnail

    -- Pricing  (USD, sourced from TCGPlayer market data)
    tcgplayer_price  DECIMAL(10, 2),                        -- market mid price
    tcgplayer_url    VARCHAR(512),                          -- direct listing link

    -- Metadata / audit
    hp               SMALLINT,
    artist           VARCHAR(128),
    release_date     DATE,
    legalities       JSONB,                                 -- {"standard":"Legal","expanded":"Legal"}
    raw_data         JSONB,                                 -- full API payload for future-proofing

    -- Row timestamps
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
--  Indexes
-- ────────────────────────────────────────────────────────────

-- 1. GIN trigram index on `name`
--    Powers fast fuzzy / partial-match searches:
--      SELECT * FROM cards WHERE name % 'Pikchu';     -- similarity
--      SELECT * FROM cards WHERE name ILIKE '%achu%'; -- partial
--    This is the primary index for OCR-result matching where
--    the scanned text may contain minor typos or truncation.
CREATE INDEX IF NOT EXISTS idx_cards_name_trgm
    ON cards USING GIN (name gin_trgm_ops);

-- 2. B-Tree index on exact `name` for equality / prefix lookups
--    and ORDER BY name queries.
CREATE INDEX IF NOT EXISTS idx_cards_name_btree
    ON cards (name);

-- 3. B-Tree index on `set_name` for set-based filtering.
CREATE INDEX IF NOT EXISTS idx_cards_set_name
    ON cards (set_name);

-- 4. B-Tree index on `set_id` (used in joins / URL routing).
CREATE INDEX IF NOT EXISTS idx_cards_set_id
    ON cards (set_id);

-- 5. B-Tree index on `rarity` for rarity-tier filtering.
CREATE INDEX IF NOT EXISTS idx_cards_rarity
    ON cards (rarity);

-- 6. Composite index for the most common list query:
--    "show me all cards from set X ordered by collector number"
CREATE INDEX IF NOT EXISTS idx_cards_set_number
    ON cards (set_id, number);

-- 7. Index on tcgplayer_price to support range / sort queries
--    (e.g. "cards worth over $50").
CREATE INDEX IF NOT EXISTS idx_cards_price
    ON cards (tcgplayer_price DESC NULLS LAST);

-- 8. GIN index on the subtypes array column so we can efficiently
--    filter: WHERE 'ex' = ANY(subtypes)
CREATE INDEX IF NOT EXISTS idx_cards_subtypes
    ON cards USING GIN (subtypes);

-- ────────────────────────────────────────────────────────────
--  Auto-update `updated_at` on every row change
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER cards_updated_at
    BEFORE UPDATE ON cards
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ────────────────────────────────────────────────────────────
--  Helpful view: cards with a confirmed price and image
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW cards_complete AS
    SELECT *
    FROM   cards
    WHERE  image_url        IS NOT NULL
      AND  tcgplayer_price  IS NOT NULL
      AND  tcgplayer_price  > 0;

-- ────────────────────────────────────────────────────────────
--  Example OCR-matching query (for reference / testing)
-- ────────────────────────────────────────────────────────────
-- Find cards whose name is ≥ 0.3 similar to the OCR result,
-- ordered by best match first, limited to top 10:
--
-- SELECT id, name, set_name, number, tcgplayer_price,
--        similarity(name, 'Pikchu') AS score
-- FROM   cards
-- WHERE  name % 'Pikchu'           -- uses GIN trgm index
-- ORDER  BY score DESC
-- LIMIT  10;
