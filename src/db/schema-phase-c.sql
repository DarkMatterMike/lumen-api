-- ============================================================
-- LUMEN PHASE C SCHEMA
-- Run this in your Neon SQL editor after schema-phase-b.sql
-- ============================================================

-- Add completed column to budgets (may already exist if referenced in code)
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE;

-- Track when pace alerts were last fired so we don't spam the user
-- (one alert per budget per month is enough)
CREATE TABLE IF NOT EXISTS budget_pace_alerts (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  budget_id   INTEGER REFERENCES budgets(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,  -- 'YYYY-MM' — one alert per budget per month
  fired_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, budget_id, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_pace_alerts_user ON budget_pace_alerts(user_id);

-- Add include_in_balance column to accounts if not already there
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS include_in_balance BOOLEAN DEFAULT TRUE;

-- Add anthropic_key to users if not there
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key TEXT;
