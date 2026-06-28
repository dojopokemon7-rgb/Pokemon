-- ─────────────────────────────────────────────────────────────
--  Task 2.5 Schema: users + user_portfolios
--  Run once against pokemon_tcg database.
-- ─────────────────────────────────────────────────────────────

-- ── 1. users ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         VARCHAR(64)  PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 2. user_portfolios ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_portfolios (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        VARCHAR(64)  NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  card_id        VARCHAR(64)  NOT NULL REFERENCES cards(id)  ON DELETE CASCADE,
  quantity       INTEGER      NOT NULL DEFAULT 1 CHECK (quantity > 0),
  purchase_price DECIMAL(10,2),          -- optional, NULL = unknown
  added_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Prevent duplicate card entries per user (use UPDATE quantity instead)
  UNIQUE (user_id, card_id)
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_portfolios_user   ON user_portfolios (user_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_card   ON user_portfolios (card_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_added  ON user_portfolios (user_id, added_at DESC);
