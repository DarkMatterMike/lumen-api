-- ============================================================
-- LUMEN AUTH + PLAID SCHEMA
-- Run this in your Neon SQL editor
-- ============================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Plaid items (one per bank connection per user)
CREATE TABLE IF NOT EXISTS plaid_items (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  access_token    TEXT NOT NULL,
  item_id         TEXT NOT NULL UNIQUE,
  institution_id  TEXT,
  institution_name TEXT,
  cursor          TEXT,        -- for transaction sync
  last_synced     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add user_id to accounts table
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plaid_account_id TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plaid_item_id INTEGER REFERENCES plaid_items(id) ON DELETE CASCADE;

-- Add user_id to transactions table
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_transaction_id TEXT UNIQUE;

-- Add user_id to budgets table
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Add user_id to recurring table
ALTER TABLE recurring ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_plaid_items_user_id ON plaid_items(user_id);
