-- ============================================================
-- POLISH MIGRATIONS — run once in Neon
-- ============================================================

-- Fix 1: Backfill NULL status on existing transactions
UPDATE transactions SET status = 'posted' WHERE status IS NULL;
ALTER TABLE transactions ALTER COLUMN status SET DEFAULT 'posted';
ALTER TABLE transactions ALTER COLUMN status SET NOT NULL;

-- Fix 2: Add terms_agreed_at column to users (for privacy policy)
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT DEFAULT '1.0';

-- Fix 3: Add dismissed_recurring_suggestions for recurring detection
CREATE TABLE IF NOT EXISTS dismissed_recurring_suggestions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  merchant    TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, merchant)
);
