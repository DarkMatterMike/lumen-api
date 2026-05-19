-- ============================================================
-- LUMEN PHASE B SCHEMA
-- Run this in your Neon SQL editor after schema-phase-a.sql
-- ============================================================

-- Merchant name cleaning map (per-user learned + global defaults)
-- Stores raw → clean name mappings so "SQ *BLUEBOTTLE 94107" → "Blue Bottle Coffee"
CREATE TABLE IF NOT EXISTS merchant_names (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global default
  raw_pattern TEXT NOT NULL,      -- normalized raw string to match (lowercase, stripped)
  clean_name  TEXT NOT NULL,      -- human-friendly display name
  category    TEXT,               -- optional: also set category when this pattern matches
  icon        TEXT,               -- optional: emoji override
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_names_user ON merchant_names(user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_names_pattern ON merchant_names(raw_pattern);

-- Track which duplicate pairs have been reviewed so we don't re-alert
CREATE TABLE IF NOT EXISTS duplicate_reviews (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  transaction_id_1 INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  transaction_id_2 INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,  -- 'confirmed_duplicate' | 'dismissed' (not a duplicate)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_duplicate_reviews_user ON duplicate_reviews(user_id);

-- Track last known amounts for recurring items so we can detect changes
-- Populated automatically when recurring items are matched to transactions
CREATE TABLE IF NOT EXISTS recurring_amount_history (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  recurring_id  INTEGER REFERENCES recurring(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  recorded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_history_user ON recurring_amount_history(user_id, recurring_id);

-- Add cleaned_name column to transactions for storing AI-cleaned merchant names
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cleaned_name TEXT;

-- Add plaid_transaction_id column if not exists (may already exist from plaid.js)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_transaction_id TEXT UNIQUE;

-- Add tx_type column if not exists
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_type TEXT;

-- Add note column if not exists
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note TEXT;

-- Add source column if not exists (also in phase-a but safe to re-run)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- Seed some global merchant name patterns (common Plaid raw names)
INSERT INTO merchant_names (user_id, raw_pattern, clean_name, category, icon) VALUES
  (NULL, 'sq *',              'Square Merchant',    NULL,            '💳'),
  (NULL, 'tst*',              'Toast Merchant',     'Dining',        '🍽️'),
  (NULL, 'doordash',          'DoorDash',           'Dining',        '🛵'),
  (NULL, 'uber eats',         'Uber Eats',          'Dining',        '🛵'),
  (NULL, 'grubhub',           'GrubHub',            'Dining',        '🛵'),
  (NULL, 'instacart',         'Instacart',          'Groceries',     '🛒'),
  (NULL, 'wholefds',          'Whole Foods',        'Groceries',     '🛒'),
  (NULL, 'whole foods',       'Whole Foods',        'Groceries',     '🛒'),
  (NULL, 'trader joe',        'Trader Joe''s',      'Groceries',     '🛒'),
  (NULL, 'costco',            'Costco',             'Groceries',     '🛒'),
  (NULL, 'amazon',            'Amazon',             'Shopping',      '📦'),
  (NULL, 'amzn',              'Amazon',             'Shopping',      '📦'),
  (NULL, 'netflix',           'Netflix',            'Subscriptions', '📺'),
  (NULL, 'spotify',           'Spotify',            'Subscriptions', '🎵'),
  (NULL, 'apple.com/bill',    'Apple Subscription', 'Subscriptions', '🍎'),
  (NULL, 'icloud',            'iCloud+',            'Subscriptions', '☁️'),
  (NULL, 'google *',          'Google',             'Subscriptions', '🔍'),
  (NULL, 'hulu',              'Hulu',               'Subscriptions', '📺'),
  (NULL, 'disney+',           'Disney+',            'Subscriptions', '🏰'),
  (NULL, 'hbo',               'HBO Max',            'Subscriptions', '📺'),
  (NULL, 'openai',            'OpenAI',             'Subscriptions', '🤖'),
  (NULL, 'chatgpt',           'ChatGPT',            'Subscriptions', '🤖'),
  (NULL, 'lyft',              'Lyft',               'Transport',     '🚗'),
  (NULL, 'uber',              'Uber',               'Transport',     '🚗'),
  (NULL, 'waymo',             'Waymo',              'Transport',     '🚗'),
  (NULL, 'chevron',           'Chevron',            'Transport',     '⛽'),
  (NULL, 'shell',             'Shell',              'Transport',     '⛽'),
  (NULL, 'exxon',             'ExxonMobil',         'Transport',     '⛽'),
  (NULL, 'walgreens',         'Walgreens',          'Healthcare',    '💊'),
  (NULL, 'cvs',               'CVS Pharmacy',       'Healthcare',    '💊'),
  (NULL, 'target',            'Target',             'Shopping',      '🎯'),
  (NULL, 'walmart',           'Walmart',            'Shopping',      '🏪'),
  (NULL, 'starbucks',         'Starbucks',          'Dining',        '☕'),
  (NULL, 'chipotle',          'Chipotle',           'Dining',        '🌯'),
  (NULL, 'mcdonald',          'McDonald''s',        'Dining',        '🍔'),
  (NULL, 'chick-fil-a',       'Chick-fil-A',        'Dining',        '🐔'),
  (NULL, 'direct deposit',    'Direct Deposit',     'Income',        '💰'),
  (NULL, 'payroll',           'Payroll Deposit',    'Income',        '💰'),
  (NULL, 'zelle',             'Zelle Transfer',     'Transfer',      '💸'),
  (NULL, 'venmo',             'Venmo',              'Transfer',      '💸'),
  (NULL, 'paypal',            'PayPal',             'Transfer',      '💸'),
  (NULL, 'apple pay cash',    'Apple Cash',         'Transfer',      '💸')
ON CONFLICT DO NOTHING;
