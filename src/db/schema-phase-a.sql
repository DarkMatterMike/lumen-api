-- ============================================================
-- LUMEN PHASE A SCHEMA
-- Run this in your Neon SQL editor after schema.sql and schema-auth.sql
-- ============================================================

-- Notifications
-- Delivered by cron jobs and AI processes; read/dismissed by user
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,        -- 'alert' | 'insight' | 'warning' | 'win'
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  icon        TEXT DEFAULT '🔔',
  read        BOOLEAN DEFAULT FALSE,
  dismissed   BOOLEAN DEFAULT FALSE,
  metadata    JSONB,                -- arbitrary context (transaction_id, amount, etc.)
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read, dismissed);

-- Goals
-- Savings goals, debt payoff targets, spending limit goals
CREATE TABLE IF NOT EXISTS goals (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,         -- 'savings' | 'debt_payoff' | 'spending_limit' | 'emergency_fund'
  target_amount NUMERIC(12, 2) NOT NULL,
  current_amount NUMERIC(12, 2) DEFAULT 0,
  monthly_contribution NUMERIC(12, 2), -- how much to set aside each month
  target_date   DATE,                  -- deadline (optional)
  account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  icon          TEXT DEFAULT '🎯',
  color         TEXT DEFAULT 'calm',
  active        BOOLEAN DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);

-- Category corrections
-- When user overrides AI categorization, we store it so AI learns
CREATE TABLE IF NOT EXISTS category_corrections (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  merchant_name   TEXT NOT NULL,        -- normalized merchant name
  original_category TEXT NOT NULL,      -- what AI or rules assigned
  corrected_category TEXT NOT NULL,     -- what user changed it to
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corrections_user_id ON category_corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_corrections_merchant ON category_corrections(user_id, merchant_name);

-- Add source column to transactions (tracks how the tx came in)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'; -- 'plaid' | 'csv' | 'manual'
