-- ============================================================
-- LUMEN PHASE D SCHEMA
-- Run this in your Neon SQL editor after schema-phase-c.sql
-- ============================================================

-- Track cash crunch alerts so we don't re-notify on the same crunch window
CREATE TABLE IF NOT EXISTS cash_crunch_alerts (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  crunch_date  DATE NOT NULL,       -- the date the crunch hits
  alert_key    TEXT NOT NULL,       -- dedupe key: 'crunch-YYYY-MM-DD'
  fired_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_cash_crunch_user ON cash_crunch_alerts(user_id);

-- Ensure accounts has a type column (checking/savings/credit/loan)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS type TEXT;

-- Ensure accounts has is_debt column
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_debt BOOLEAN DEFAULT FALSE;
