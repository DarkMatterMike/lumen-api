-- ============================================================
-- LUMEN PHASE E SCHEMA
-- Run this in your Neon SQL editor after schema-phase-d.sql
-- ============================================================

-- Dedupe table for all Phase E alerts so cron doesn't repeat them
CREATE TABLE IF NOT EXISTS proactive_alert_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  alert_key  TEXT NOT NULL,        -- unique key per alert type + subject + window
  fired_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_alert_log_user ON proactive_alert_log(user_id);

-- Track per-merchant baseline spend so anomaly detection has a reference
-- Rebuilt on each run — upserted, not appended
CREATE TABLE IF NOT EXISTS merchant_baselines (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,   -- normalized merchant name
  avg_amount   NUMERIC(12,2),   -- rolling average transaction amount
  visit_count  INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, merchant_key)
);

CREATE INDEX IF NOT EXISTS idx_baselines_user ON merchant_baselines(user_id);
