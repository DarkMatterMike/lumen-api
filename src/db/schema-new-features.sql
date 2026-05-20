-- ============================================================
-- LUMEN NEW FEATURES SCHEMA (2-6-7-8-9-10)
-- Run this in your Neon SQL editor
-- ============================================================

-- Feature 2: Financial Decision Memory
CREATE TABLE IF NOT EXISTS financial_decisions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,               -- "Paid off car loan early"
  body         TEXT,                        -- full note / context
  category     TEXT,                        -- 'debt' | 'savings' | 'spending' | 'investment' | 'other'
  amount       NUMERIC(12,2),               -- dollar amount involved (optional)
  decided_at   DATE NOT NULL DEFAULT CURRENT_DATE,
  follow_up_at DATE,                        -- when Lumen should check in
  followed_up  BOOLEAN DEFAULT FALSE,
  outcome      TEXT,                        -- filled in at follow-up
  icon         TEXT DEFAULT '📝',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_decisions_user    ON financial_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_decisions_followup ON financial_decisions(user_id, follow_up_at)
  WHERE followed_up = FALSE;

-- Feature 6: Net Worth Snapshots (weekly)
CREATE TABLE IF NOT EXISTS net_worth_snapshots (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  net_worth    NUMERIC(12,2) NOT NULL,
  assets       NUMERIC(12,2) NOT NULL,
  liabilities  NUMERIC(12,2) NOT NULL,
  breakdown    JSONB,          -- per-account snapshot
  UNIQUE(user_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_nw_snapshots_user ON net_worth_snapshots(user_id, snapshot_date DESC);

-- Feature 7: Bill Outcome Tracking
CREATE TABLE IF NOT EXISTS bill_history (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  bill_name    TEXT NOT NULL,              -- normalized bill name
  amount       NUMERIC(10,2) NOT NULL,
  recorded_date DATE NOT NULL,
  source       TEXT DEFAULT 'transaction', -- 'transaction' | 'document' | 'recurring'
  account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_bill_history_user ON bill_history(user_id, bill_name, recorded_date DESC);

-- Feature 8: Spending DNA
CREATE TABLE IF NOT EXISTS spending_dna (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  month_key    TEXT NOT NULL,              -- 'YYYY-MM'
  dna          JSONB NOT NULL,             -- full structured DNA object
  narrative    TEXT NOT NULL,              -- AI-written personality paragraph
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, month_key)
);
CREATE INDEX IF NOT EXISTS idx_dna_user ON spending_dna(user_id, month_key DESC);

-- Feature 10: Notification Intelligence / Feedback
CREATE TABLE IF NOT EXISTS notification_feedback (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,         -- matches notifications.type
  action          TEXT NOT NULL,           -- 'opened' | 'dismissed' | 'acted'
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_feedback_user ON notification_feedback(user_id, notification_type);

-- Suppression preferences derived from feedback
CREATE TABLE IF NOT EXISTS notification_suppression (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  suppressed      BOOLEAN DEFAULT FALSE,
  suppress_reason TEXT,                    -- 'low_open_rate' | 'always_dismissed' | 'user_muted'
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notification_type)
);
CREATE INDEX IF NOT EXISTS idx_notif_suppression_user ON notification_suppression(user_id);
