/**
 * recurringDetection.js
 * Scans transaction history to detect recurring charges that aren't yet in the recurring table.
 * Looks for amounts that repeat monthly (±$2) from the same merchant, 2+ times.
 */
const pool = require('../db/pool')

async function detectRecurringCandidates(userId) {
  // Find transactions that appear multiple times with same merchant + similar amount
  const { rows } = await pool.query(
    `SELECT
       LOWER(TRIM(COALESCE(cleaned_name, name))) AS merchant,
       ROUND(AVG(ABS(amount))::numeric, 2)       AS avg_amount,
       COUNT(*)                                   AS occurrences,
       MIN(date)                                  AS first_seen,
       MAX(date)                                  AS last_seen,
       MODE() WITHIN GROUP (ORDER BY EXTRACT(DAY FROM date))::int AS typical_day,
       COALESCE(MAX(category), 'Other')           AS category,
       COALESCE(MAX(icon), '🔁')                  AS icon
     FROM transactions
     WHERE user_id = $1
       AND amount < 0
       AND COALESCE(tx_type, 'expense') != 'transfer'
       AND date >= CURRENT_DATE - INTERVAL '6 months'
     GROUP BY LOWER(TRIM(COALESCE(cleaned_name, name)))
     HAVING COUNT(*) >= 2
        AND STDDEV(ABS(amount)) < 2.5         -- tight amount variance = recurring
        AND MAX(date) >= CURRENT_DATE - INTERVAL '45 days'  -- still active
     ORDER BY occurrences DESC, avg_amount DESC
     LIMIT 30`,
    [userId]
  )

  if (!rows.length) return []

  // Filter out merchants already in the recurring table
  const { rows: existing } = await pool.query(
    `SELECT LOWER(TRIM(name)) AS name FROM recurring WHERE user_id = $1`,
    [userId]
  )
  const existingNames = new Set(existing.map(r => r.name))

  const candidates = rows
    .filter(r => !existingNames.has(r.merchant))
    .map(r => ({
      merchant:    r.merchant,
      avg_amount:  Number(r.avg_amount),
      occurrences: Number(r.occurrences),
      first_seen:  r.first_seen,
      last_seen:   r.last_seen,
      typical_day: Number(r.typical_day) || 1,
      category:    r.category,
      icon:        r.icon,
      // Classify type from category
      type: ['Income', 'Paycheck', 'Direct Deposit'].some(k =>
        r.category?.toLowerCase().includes(k.toLowerCase())) ? 'income' :
        r.category === 'Subscriptions' ? 'subscription' : 'bill',
    }))

  return candidates
}

async function addRecurringFromDetection(userId, { merchant, avg_amount, typical_day, type, icon, category }) {
  // Capitalize merchant name properly
  const name = merchant
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  const { rows } = await pool.query(
    `INSERT INTO recurring (user_id, name, amount, day_of_month, type, icon, active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [userId, name, avg_amount, Math.max(1, Math.min(28, typical_day)), type || 'bill', icon || '🔁']
  )
  return rows[0] || null
}

module.exports = { detectRecurringCandidates, addRecurringFromDetection }
