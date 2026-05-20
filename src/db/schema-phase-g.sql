-- ============================================================
-- LUMEN PHASE G SCHEMA
-- Run this in your Neon SQL editor after schema-phase-f.sql
-- ============================================================

-- Add minimum_payment to accounts (needed for payoff modeling)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS minimum_payment NUMERIC(10,2);

-- Dedupe table for payoff opportunity alerts (reuse proactive_alert_log from Phase E)
-- No new tables needed — proactive_alert_log handles deduplication
