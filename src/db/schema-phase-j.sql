-- Phase J: per-account cash-flow forecast roles
-- Run this in your Neon SQL editor after schema-phase-i.sql
--
-- role drives the account forecast engine:
--   'source'    → checking accounts paychecks land in; can fund transfers; OK to run low
--   'protected' → accounts that must stay funded (e.g. Cap One Autopay / Spending)
--   'ignore'    → excluded from the forecast entirely (untouched savings, etc.)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS forecast_role TEXT;

-- Sensible starting defaults (user can override per account in the UI):
--   checking accounts → source
--   everything else   → ignore
UPDATE accounts
   SET forecast_role = CASE
       WHEN COALESCE(is_debt, FALSE) = TRUE THEN 'ignore'
       WHEN type = 'checking'               THEN 'source'
       ELSE 'ignore'
   END
 WHERE forecast_role IS NULL;
