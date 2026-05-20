-- ============================================================
-- LUMEN PHASE I SCHEMA
-- Run this in your Neon SQL editor after schema-phase-h.sql
-- ============================================================

-- Financial health score history — one row per week per user
CREATE TABLE IF NOT EXISTS health_scores (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  week_key     TEXT NOT NULL,          -- 'YYYY-WW'
  score        INTEGER NOT NULL,       -- 0-100
  components   JSONB,                  -- breakdown of score factors
  computed_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, week_key)
);

CREATE INDEX IF NOT EXISTS idx_health_scores_user ON health_scores(user_id, computed_at DESC);

-- Behavioral insights — stored so we don't recompute every time
CREATE TABLE IF NOT EXISTS behavioral_insights (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  insight_key  TEXT NOT NULL,          -- e.g. 'weekend_spike', 'low_balance_splurge'
  insight_text TEXT NOT NULL,          -- human-readable finding
  data         JSONB,                  -- supporting data
  computed_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, insight_key)
);

CREATE INDEX IF NOT EXISTS idx_behavioral_user ON behavioral_insights(user_id);

-- Adaptive budget history — track what we suggested so we don't repeat
CREATE TABLE IF NOT EXISTS adaptive_budget_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  budget_id   INTEGER REFERENCES budgets(id) ON DELETE CASCADE,
  old_cap     NUMERIC(12,2),
  suggested_cap NUMERIC(12,2),
  month       TEXT NOT NULL,           -- 'YYYY-MM'
  reason      TEXT,
  applied     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, budget_id, month)
);

CREATE INDEX IF NOT EXISTS idx_adaptive_budget_user ON adaptive_budget_log(user_id);
