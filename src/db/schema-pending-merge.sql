-- ============================================================
-- PENDING TRANSACTIONS & MERGE CANDIDATES
-- Run in Neon after existing schemas
-- ============================================================

-- 1. Add status and pending_source to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'posted'; -- 'pending' | 'posted'
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pending_source TEXT;          -- 'email' | 'manual'
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS email_subject TEXT;           -- source email subject

-- 2. Merge candidates — suggested pending→posted pairs awaiting user decision
CREATE TABLE IF NOT EXISTS merge_candidates (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  pending_tx_id   INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  posted_tx_id    INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  confidence      TEXT NOT NULL DEFAULT 'high',  -- 'high' | 'medium'
  confidence_score NUMERIC(4,2),                 -- 0-1
  match_reason    TEXT,                          -- human-readable reason
  status          TEXT NOT NULL DEFAULT 'pending_review', -- 'pending_review' | 'merged' | 'kept_separate'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE(pending_tx_id, posted_tx_id)
);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_user ON merge_candidates(user_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_candidates_pending ON merge_candidates(pending_tx_id);
CREATE INDEX IF NOT EXISTS idx_merge_candidates_posted ON merge_candidates(posted_tx_id);

-- 3. gmail_pending_charges (if not already created elsewhere)
CREATE TABLE IF NOT EXISTS gmail_pending_charges (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  merchant        TEXT NOT NULL,
  amount          NUMERIC(12,2),
  order_date      DATE,
  expected_charge DATE,
  email_subject   TEXT,
  icon            TEXT,
  status          TEXT DEFAULT 'pending',  -- 'pending' | 'matched' | 'dismissed'
  gmail_order_id  INTEGER,
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gmail_pending_user ON gmail_pending_charges(user_id, status);
