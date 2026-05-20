/**
 * recurringDetection.js
 * Scans transaction history for amounts that repeat monthly (±$2, ±3 days same day-of-month).
 * Surfaces them as recurring_suggestions for user review.
 */
const pool = require('../db/pool')

async function detectRecurringItems(userId) {
  // Find transactions that appear ≥2 times in the last 4 months, negative (expenses)
  // Group by normalized name + approximate amount
  const { rows } = await pool.query(
    `SELECT
       LOWER(COALESCE(cleaned_name, name)) AS norm_name,
       ROUND(ABS(amount) / 5) * 5          AS amount_bucket,  -- bucket to nearest $5 for fuzzy match
       COUNT(*)                            AS occurrences,
       MIN(date)                           AS first_seen,
       MAX(date)                           AS last_seen,
       AVG(ABS(amount))                    AS avg_amount,
       MODE() WITHIN GROUP (ORDER BY EXTRACT(DAY FROM date)) AS modal_day,
       MAX(icon)                           AS icon
     FROM transactions
     WHERE user_id=$1
       AND amount < 0
       AND COALESCE(tx_type,'expense') NOT IN ('transfer','income')
       AND date >= CURRENT_DATE - INTERVAL '4 months'
     GROUP BY norm_name, amount_bucket
     HAVING COUNT(*) >= 2
       AND COUNT(DISTINCT DATE_TRUNC('month', date)) >= 2  -- appeared in at least 2 different months
     ORDER BY occurrences DESC, avg_amount DESC
     LIMIT 50`,
    [userId]
  )

  // Filter out names already in recurring table
  const { rows: existing } = await pool.query(
    `SELECT LOWER(name) AS name FROM recurring WHERE user_id=$1 AND active=TRUE`,
    [userId]
  )
  const existingNames = new Set(existing.map(r => r.name))

  let added = 0

  for (const row of rows) {
    const normName = row.norm_name
    if (!normName || normName.length < 2) continue

    // Skip if already a recurring item
    if (existingNames.has(normName)) continue

    // Skip if already suggested (pending or accepted)
    const { rows: alreadySuggested } = await pool.query(
      `SELECT id FROM recurring_suggestions
       WHERE user_id=$1 AND LOWER(name)=$2 AND status != 'dismissed'`,
      [userId, normName]
    )
    if (alreadySuggested.length) continue

    // Determine type hint
    const type = detectType(normName, Number(row.avg_amount))

    await pool.query(
      `INSERT INTO recurring_suggestions
         (user_id, name, amount, day_of_month, type, icon, occurrences, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        userId,
        titleCase(normName),
        Math.round(Number(row.avg_amount) * 100) / 100,
        row.modal_day ? Math.round(Number(row.modal_day)) : null,
        type,
        row.icon || iconForType(type),
        Number(row.occurrences),
        row.first_seen,
        row.last_seen,
      ]
    )
    added++
  }

  return added
}

async function getSuggestions(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM recurring_suggestions
     WHERE user_id=$1 AND status='pending'
     ORDER BY occurrences DESC, amount DESC`,
    [userId]
  )
  return rows
}

async function acceptSuggestion(userId, suggestionId) {
  const { rows } = await pool.query(
    `SELECT * FROM recurring_suggestions WHERE id=$1 AND user_id=$2`,
    [suggestionId, userId]
  )
  if (!rows.length) throw new Error('Not found')
  const s = rows[0]

  // Create actual recurring item
  const { rows: created } = await pool.query(
    `INSERT INTO recurring (user_id, name, amount, day_of_month, type, icon, active)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
    [userId, s.name, s.amount, s.day_of_month || 1, s.type, s.icon]
  )

  // Mark suggestion accepted
  await pool.query(
    `UPDATE recurring_suggestions SET status='accepted' WHERE id=$1`,
    [suggestionId]
  )

  return created[0]
}

async function dismissSuggestion(userId, suggestionId) {
  await pool.query(
    `UPDATE recurring_suggestions SET status='dismissed' WHERE id=$1 AND user_id=$2`,
    [suggestionId, userId]
  )
}

// ── Helpers ───────────────────────────────────────────────────
function detectType(name, amount) {
  const n = name.toLowerCase()
  const subscriptionKeywords = ['netflix','spotify','hulu','disney','apple','amazon prime','hbo','youtube','claude','chatgpt','openai','dropbox','icloud','google one','adobe','notion','slack']
  if (subscriptionKeywords.some(k => n.includes(k))) return 'subscription'
  if (/paycheck|direct deposit|salary|payroll|zelle.*from/.test(n)) return 'income'
  if (/gym|fitness|planet|equinox/.test(n)) return 'subscription'
  if (/rent|mortgage|lease/.test(n)) return 'bill'
  if (/electric|gas|water|utility|utilities|internet|phone|wireless|at&t|verizon|comcast|xfinity/.test(n)) return 'bill'
  return amount > 200 ? 'bill' : 'subscription'
}

function iconForType(type) {
  return { bill: '🧾', subscription: '📱', income: '💰' }[type] || '🔄'
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase())
}

module.exports = { detectRecurringItems, getSuggestions, acceptSuggestion, dismissSuggestion }
