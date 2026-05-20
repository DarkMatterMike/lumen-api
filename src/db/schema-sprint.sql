-- ============================================================
-- SCHEMA: Sprint additions
-- Run in Neon SQL editor
-- ============================================================

-- 1. Terms & privacy agreement on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_agreed_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version      TEXT DEFAULT '1.0';
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_agreed_at  TIMESTAMPTZ;

-- 2. Fix existing transactions with NULL status (reliability fix)
UPDATE transactions SET status = 'posted' WHERE status IS NULL;

-- 3. Recurring detection candidates table
CREATE TABLE IF NOT EXISTS recurring_suggestions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  day_of_month INTEGER,
  type         TEXT DEFAULT 'bill',       -- 'bill' | 'subscription' | 'income'
  icon         TEXT,
  occurrences  INTEGER DEFAULT 0,         -- how many times seen
  first_seen   DATE,
  last_seen    DATE,
  status       TEXT DEFAULT 'pending',    -- 'pending' | 'accepted' | 'dismissed'
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recurring_suggestions_user ON recurring_suggestions(user_id, status);

-- 4. Data export log (track exports for audit trail)
CREATE TABLE IF NOT EXISTS export_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,  -- 'csv' | 'json' | 'pdf'
  date_from  DATE,
  date_to    DATE,
  row_count  INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
