-- ============================================================
-- LUMEN DATABASE SCHEMA
-- Run this once in your Neon SQL editor to create all tables
-- ============================================================

-- Accounts (checking, savings, credit cards, loans)
CREATE TABLE IF NOT EXISTS accounts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,       -- 'checking' | 'savings' | 'credit' | 'loan'
  institution TEXT NOT NULL,
  balance     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  limit_amt   NUMERIC(12, 2),      -- credit cards only
  interest_rate NUMERIC(5, 2),     -- savings / loans
  is_debt     BOOLEAN DEFAULT FALSE,
  mask        TEXT,                -- last 4 digits e.g. '4821'
  color       TEXT,                -- UI accent e.g. 'safe' | 'calm' | 'debt'
  icon        TEXT,                -- emoji
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts(id),
  name        TEXT NOT NULL,
  amount      NUMERIC(12, 2) NOT NULL,  -- negative = expense, positive = income
  category    TEXT NOT NULL,
  icon        TEXT,
  balance_after NUMERIC(12, 2),
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Budget categories
CREATE TABLE IF NOT EXISTS budgets (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,
  cap         NUMERIC(12, 2) NOT NULL,
  period      TEXT DEFAULT 'monthly',
  color       TEXT DEFAULT 'safe',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Recurring bills / scheduled events
CREATE TABLE IF NOT EXISTS recurring (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  amount      NUMERIC(12, 2) NOT NULL,
  day_of_month INTEGER NOT NULL,     -- 1-31, day it hits each month
  type        TEXT NOT NULL,         -- 'bill' | 'income' | 'subscription'
  icon        TEXT,
  account_id  INTEGER REFERENCES accounts(id),
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SEED DATA — sample data so the app works immediately
-- ============================================================

-- Accounts
INSERT INTO accounts (name, type, institution, balance, mask, icon, color, interest_rate, is_debt, limit_amt) VALUES
  ('Checking',          'checking',     'Chase',   4218.00, '4821', '🏦', 'safe',  NULL,  FALSE, NULL),
  ('High-Yield Savings','savings',      'Marcus',  8441.00, '7203', '💰', 'calm',  4.50,  FALSE, NULL),
  ('Sapphire Reserve',  'credit',       'Chase',      0.00, '9142', '💜', 'goal',  NULL,  TRUE,  15000.00),
  ('Student Loan',      'loan',         'Federal',  6000.00, '8847', '🎓', 'debt',  5.05,  TRUE,  NULL)
ON CONFLICT DO NOTHING;

-- Budgets
INSERT INTO budgets (name, icon, cap, color) VALUES
  ('Housing',       '🏠', 1400.00, 'debt'),
  ('Dining & Food', '🍽️', 200.00,  'warn'),
  ('Groceries',     '🛒', 300.00,  'safe'),
  ('Transport',     '🚗',  80.00,  'calm'),
  ('Subscriptions', '📱',  60.00,  'calm')
ON CONFLICT DO NOTHING;

-- Recurring
INSERT INTO recurring (name, amount, day_of_month, type, icon) VALUES
  ('Paycheck',     2840.00,  1,  'income',       '💰'),
  ('Paycheck',     2840.00, 15,  'income',       '💰'),
  ('Rent',         1350.00,  5,  'bill',         '🏠'),
  ('Netflix',        15.49, 14,  'subscription', '📺'),
  ('Electric',       94.00, 17,  'bill',         '⚡'),
  ('AT&T Wireless',  85.00, 20,  'bill',         '📱'),
  ('Spotify',        10.99, 22,  'subscription', '🎵'),
  ('iCloud+',        10.99, 29,  'subscription', '☁️'),
  ('Internet',       79.00, 31,  'bill',         '🌐')
ON CONFLICT DO NOTHING;

-- Transactions (recent history)
INSERT INTO transactions (account_id, name, amount, category, icon, balance_after, date) VALUES
  (1, 'City Electric Co.',      -94.00,    'Utilities',      '⚡', 4218.00, CURRENT_DATE),
  (1, 'Domino''s Pizza',        -28.47,    'Dining',         '🍕', 4312.00, CURRENT_DATE),
  (1, 'Direct Deposit',        2840.00,    'Income',         '🏦', 4340.00, CURRENT_DATE - 1),
  (1, 'Whole Foods Market',     -112.33,   'Groceries',      '🛒', 1500.00, CURRENT_DATE - 1),
  (1, 'Spotify',                -10.99,    'Subscriptions',  '🎵', 1612.00, CURRENT_DATE - 1),
  (1, 'Rent Payment',          -1350.00,   'Housing',        '🏠', 1623.00, CURRENT_DATE - 2),
  (1, 'Blue Bottle Coffee',       -6.75,   'Dining',         '☕', 2973.00, CURRENT_DATE - 2),
  (1, 'Uber',                   -18.40,    'Transport',      '🚗', 2980.00, CURRENT_DATE - 2),
  (1, 'Chipotle Mexican Grill',  -14.95,   'Dining',         '🍔', 2998.00, CURRENT_DATE - 2),
  (1, 'Netflix',                -15.49,    'Subscriptions',  '📺', 3012.00, CURRENT_DATE - 3),
  (1, 'Amazon',                 -43.99,    'Shopping',       '🛍️', 3027.00, CURRENT_DATE - 3)
ON CONFLICT DO NOTHING;
