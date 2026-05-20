-- ============================================================
-- LUMEN PHASE H SCHEMA
-- Run this in your Neon SQL editor after schema-phase-g.sql
-- ============================================================

-- Track uploaded documents so users can see parse history
CREATE TABLE IF NOT EXISTS document_uploads (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL,   -- 'bank_statement' | 'pay_stub' | 'loan_doc' | 'insurance' | 'other'
  filename      TEXT,
  parsed_at     TIMESTAMPTZ DEFAULT NOW(),
  result        JSONB,           -- structured extraction result
  tx_imported   INTEGER DEFAULT 0,  -- how many transactions were imported
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_doc_uploads_user ON document_uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_uploads_type ON document_uploads(user_id, doc_type);
