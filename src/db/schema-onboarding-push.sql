-- ============================================================
-- LUMEN ONBOARDING + PUSH SCHEMA
-- Run in Neon after schema-new-features.sql
-- ============================================================

-- Track onboarding state per user
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step     INTEGER DEFAULT 0;

-- Push notification subscriptions (one per device)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- Track which notifications were pushed so we don't double-push
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed BOOLEAN DEFAULT FALSE;
