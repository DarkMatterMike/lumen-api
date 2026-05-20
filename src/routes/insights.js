/**
 * New Features Route
 *
 * Decisions (Feature 2):
 *   GET    /api/insights/decisions
 *   POST   /api/insights/decisions
 *   PATCH  /api/insights/decisions/:id
 *   DELETE /api/insights/decisions/:id
 *   POST   /api/insights/decisions/:id/outcome
 *
 * Net Worth Trajectory (Feature 6):
 *   GET    /api/insights/net-worth
 *   POST   /api/insights/net-worth/snapshot
 *
 * Bill History (Feature 7):
 *   GET    /api/insights/bill-history
 *   GET    /api/insights/bill-history/annual
 *
 * Spending DNA (Feature 8):
 *   GET    /api/insights/dna
 *   POST   /api/insights/dna/generate
 *
 * Lifetime Queries (Feature 9):
 *   GET    /api/insights/lifetime
 *
 * Notification Intelligence (Feature 10):
 *   POST   /api/insights/notification-feedback
 *   GET    /api/insights/notification-suppression
 *   POST   /api/insights/notification-suppression/:type/unsuppress
 */
const express  = require('express')
const router   = express.Router()
const pool     = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { snapshotNetWorth, getNetWorthHistory, projectNetWorth } = require('../utils/netWorthTrajectory')
const { generateDna, getLatestDna } = require('../utils/spendingDna')
const { recordFeedback, recomputeSuppressions, getSuppressionSummary, unSuppress } = require('../utils/notificationIntelligence')

router.use(requireAuth)

// ══════════════════════════════════════════════════════════
// FEATURE 2 — FINANCIAL DECISIONS
// ══════════════════════════════════════════════════════════

router.get('/decisions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM financial_decisions
       WHERE user_id=$1 ORDER BY decided_at DESC`,
      [req.user.id]
    )
    // Check for follow-ups due
    const followUps = rows.filter(d =>
      !d.followed_up && d.follow_up_at && new Date(d.follow_up_at) <= new Date()
    )
    res.json({ decisions: rows, pending_followups: followUps })
  } catch (err) { next(err) }
})

router.post('/decisions', async (req, res, next) => {
  try {
    const { title, body, category, amount, decided_at, follow_up_at, icon } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })

    // Auto-set follow-up date to 3 months out if not provided
    const followUpDate = follow_up_at || (() => {
      const d = new Date()
      d.setMonth(d.getMonth() + 3)
      return d.toISOString().slice(0, 10)
    })()

    const { rows } = await pool.query(
      `INSERT INTO financial_decisions (user_id, title, body, category, amount, decided_at, follow_up_at, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, title, body || null, category || 'other',
       amount || null, decided_at || new Date(), followUpDate,
       icon || '📝']
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

router.patch('/decisions/:id', async (req, res, next) => {
  try {
    const { title, body, category, amount, follow_up_at, icon } = req.body
    const { rows } = await pool.query(
      `UPDATE financial_decisions SET
         title       = COALESCE($1, title),
         body        = COALESCE($2, body),
         category    = COALESCE($3, category),
         amount      = COALESCE($4, amount),
         follow_up_at = COALESCE($5, follow_up_at),
         icon        = COALESCE($6, icon)
       WHERE id=$7 AND user_id=$8 RETURNING *`,
      [title, body, category, amount, follow_up_at, icon, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.delete('/decisions/:id', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM financial_decisions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.post('/decisions/:id/outcome', async (req, res, next) => {
  try {
    const { outcome } = req.body
    const { rows } = await pool.query(
      `UPDATE financial_decisions SET outcome=$1, followed_up=TRUE
       WHERE id=$2 AND user_id=$3 RETURNING *`,
      [outcome, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ══════════════════════════════════════════════════════════
// FEATURE 6 — NET WORTH TRAJECTORY
// ══════════════════════════════════════════════════════════

router.get('/net-worth', async (req, res, next) => {
  try {
    const months = parseInt(req.query.months || '12')
    const [history, projection] = await Promise.all([
      getNetWorthHistory(req.user.id, months),
      projectNetWorth(req.user.id, 24),
    ])
    res.json({ history, projection })
  } catch (err) { next(err) }
})

router.post('/net-worth/snapshot', async (req, res, next) => {
  try {
    const result = await snapshotNetWorth(req.user.id)
    res.json({ success: true, ...result })
  } catch (err) { next(err) }
})

// ══════════════════════════════════════════════════════════
// FEATURE 7 — BILL HISTORY & ANNUAL COMPARISON
// ══════════════════════════════════════════════════════════

router.get('/bill-history', async (req, res, next) => {
  try {
    // Auto-populate bill_history from recurring transactions if empty
    await populateBillHistory(req.user.id)

    const { rows } = await pool.query(
      `SELECT bill_name,
         json_agg(json_build_object(
           'date', recorded_date,
           'amount', amount,
           'source', source
         ) ORDER BY recorded_date DESC) AS history,
         MAX(amount) AS max_amount,
         MIN(amount) AS min_amount,
         AVG(amount) AS avg_amount,
         COUNT(*) AS occurrence_count,
         MAX(recorded_date) AS last_seen
       FROM bill_history
       WHERE user_id=$1
       GROUP BY bill_name
       ORDER BY MAX(recorded_date) DESC`,
      [req.user.id]
    )
    res.json({ bills: rows })
  } catch (err) { next(err) }
})

router.get('/bill-history/annual', async (req, res, next) => {
  try {
    await populateBillHistory(req.user.id)

    // Compare this year vs last year per bill
    const { rows } = await pool.query(
      `SELECT
         bill_name,
         SUM(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) THEN amount ELSE 0 END) AS this_year,
         SUM(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) - 1 THEN amount ELSE 0 END) AS last_year,
         COUNT(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) THEN 1 END) AS this_year_count,
         -- Most recent amount for this year vs last
         MAX(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) THEN amount END) AS latest_this_year,
         MAX(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) - 1 THEN amount END) AS latest_last_year
       FROM bill_history
       WHERE user_id=$1
         AND recorded_date >= CURRENT_DATE - INTERVAL '2 years'
       GROUP BY bill_name
       HAVING COUNT(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) - 1 THEN 1 END) > 0
       ORDER BY ABS(
         COALESCE(MAX(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) THEN amount END), 0) -
         COALESCE(MAX(CASE WHEN EXTRACT(YEAR FROM recorded_date) = EXTRACT(YEAR FROM CURRENT_DATE) - 1 THEN amount END), 0)
       ) DESC`,
      [req.user.id]
    )

    const totalThisYear  = rows.reduce((s, r) => s + Number(r.this_year || 0), 0)
    const totalLastYear  = rows.reduce((s, r) => s + Number(r.last_year || 0), 0)
    const increased      = rows.filter(r => Number(r.latest_this_year || 0) > Number(r.latest_last_year || 0))
    const totalIncrease  = increased.reduce((s, r) => s + (Number(r.latest_this_year || 0) - Number(r.latest_last_year || 0)), 0)

    res.json({
      bills: rows,
      summary: {
        total_this_year:  Math.round(totalThisYear),
        total_last_year:  Math.round(totalLastYear),
        yoy_change:       Math.round(totalThisYear - totalLastYear),
        bills_increased:  increased.length,
        total_increase:   Math.round(totalIncrease),
      }
    })
  } catch (err) { next(err) }
})

async function populateBillHistory(userId) {
  // Pull recurring transactions tagged to recurring items and upsert into bill_history
  const { rows: recurringTxs } = await pool.query(
    `SELECT DISTINCT ON (LOWER(COALESCE(t.cleaned_name, t.name)), DATE_TRUNC('month', t.date))
       LOWER(COALESCE(t.cleaned_name, t.name)) AS bill_name,
       ABS(t.amount) AS amount,
       t.date::date AS recorded_date,
       t.account_id
     FROM transactions t
     WHERE t.user_id=$1
       AND t.amount < 0
       AND COALESCE(t.tx_type,'expense') != 'transfer'
       AND t.category IN ('Housing','Utilities','Subscriptions','Healthcare','Insurance')
       AND t.date >= CURRENT_DATE - INTERVAL '2 years'
     ORDER BY LOWER(COALESCE(t.cleaned_name, t.name)), DATE_TRUNC('month', t.date), t.date DESC`,
    [userId]
  )

  for (const tx of recurringTxs) {
    await pool.query(
      `INSERT INTO bill_history (user_id, bill_name, amount, recorded_date, source, account_id)
       VALUES ($1,$2,$3,$4,'transaction',$5)
       ON CONFLICT DO NOTHING`,
      [userId, tx.bill_name, tx.amount, tx.recorded_date, tx.account_id]
    ).catch(() => {})
  }
}

// ══════════════════════════════════════════════════════════
// FEATURE 8 — SPENDING DNA
// ══════════════════════════════════════════════════════════

router.get('/dna', async (req, res, next) => {
  try {
    const dnas = await getLatestDna(req.user.id)
    res.json({ dnas })
  } catch (err) { next(err) }
})

router.post('/dna/generate', async (req, res, next) => {
  try {
    // Force regenerate by deleting this month's first
    if (req.body.force) {
      const monthKey = new Date().toISOString().slice(0, 7)
      await pool.query(
        'DELETE FROM spending_dna WHERE user_id=$1 AND month_key=$2',
        [req.user.id, monthKey]
      )
    }
    const dna = await generateDna(req.user.id)
    if (!dna) return res.status(402).json({ error: 'NO_KEY' })
    res.json(dna)
  } catch (err) { next(err) }
})

// ══════════════════════════════════════════════════════════
// FEATURE 9 — LIFETIME QUERIES
// ══════════════════════════════════════════════════════════

router.get('/lifetime', async (req, res, next) => {
  try {
    const uid = req.user.id

    const [totals, topMerchants, topCategories, monthlyTrend, firstTx] = await Promise.all([
      pool.query(
        `SELECT
           SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS total_spent,
           SUM(CASE WHEN amount > 0 AND COALESCE(tx_type,'expense') != 'transfer' THEN amount ELSE 0 END) AS total_income,
           COUNT(CASE WHEN amount < 0 THEN 1 END) AS tx_count,
           MIN(date) AS first_date,
           MAX(date) AS last_date
         FROM transactions WHERE user_id=$1`,
        [uid]
      ),
      pool.query(
        `SELECT COALESCE(cleaned_name, name) AS merchant,
                SUM(ABS(amount)) AS total, COUNT(*) AS visits
         FROM transactions WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
         GROUP BY COALESCE(cleaned_name, name)
         ORDER BY total DESC LIMIT 10`,
        [uid]
      ),
      pool.query(
        `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count
         FROM transactions WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
         GROUP BY category ORDER BY total DESC LIMIT 10`,
        [uid]
      ),
      pool.query(
        `SELECT date_trunc('month', date) AS month,
                SUM(ABS(amount)) AS spent
         FROM transactions WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
         GROUP BY month ORDER BY month ASC`,
        [uid]
      ),
      pool.query(
        'SELECT MIN(date) AS first FROM transactions WHERE user_id=$1',
        [uid]
      ),
    ])

    const t = totals.rows[0]
    const daysSince = firstTx.rows[0]?.first
      ? Math.round((Date.now() - new Date(firstTx.rows[0].first)) / 86400000)
      : 0

    res.json({
      total_spent:      Math.round(Number(t?.total_spent || 0)),
      total_income:     Math.round(Number(t?.total_income || 0)),
      transaction_count: Number(t?.tx_count || 0),
      days_tracked:     daysSince,
      first_date:       t?.first_date,
      daily_avg:        daysSince > 0 ? Math.round(Number(t?.total_spent || 0) / daysSince) : 0,
      top_merchants:    topMerchants.rows.map(r => ({ ...r, total: Math.round(Number(r.total)), visits: Number(r.visits) })),
      top_categories:   topCategories.rows.map(r => ({ ...r, total: Math.round(Number(r.total)), count: Number(r.count) })),
      monthly_trend:    monthlyTrend.rows.map(r => ({ month: String(r.month).slice(0, 7), spent: Math.round(Number(r.spent)) })),
    })
  } catch (err) { next(err) }
})

// ══════════════════════════════════════════════════════════
// FEATURE 10 — NOTIFICATION INTELLIGENCE
// ══════════════════════════════════════════════════════════

router.post('/notification-feedback', async (req, res, next) => {
  try {
    const { notification_type, action } = req.body
    if (!notification_type || !action) return res.status(400).json({ error: 'notification_type and action required' })
    await recordFeedback(req.user.id, notification_type, action)
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.get('/notification-suppression', async (req, res, next) => {
  try {
    const summary = await getSuppressionSummary(req.user.id)
    res.json(summary)
  } catch (err) { next(err) }
})

router.post('/notification-suppression/:type/unsuppress', async (req, res, next) => {
  try {
    await unSuppress(req.user.id, req.params.type)
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
