const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { predictEndOfMonth, checkPaceAlerts, autoCompleteCategories } = require('../utils/budgetIntelligence')

router.use(requireAuth)

// GET /api/budgets
router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: budgets } = await pool.query(
      'SELECT * FROM budgets WHERE user_id=$1 ORDER BY cap DESC',
      [uid]
    )

    const budgetsWithSpend = await Promise.all(
      budgets.map(async (budget) => {
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(ABS(amount)),0) AS spent
           FROM transactions
           WHERE user_id=$1 AND category ILIKE $2 AND amount<0 AND COALESCE(tx_type,'expense') != 'transfer'
             AND date>=date_trunc('month',CURRENT_DATE)`,
          [uid, budget.name]
        )
        return {
          ...budget,
          spent: Number(rows[0].spent),
          pct: Math.round((Number(rows[0].spent) / Number(budget.cap)) * 100),
        }
      })
    )

    const totalBudgeted = budgets.reduce((s, b) => s + Number(b.cap), 0)
    const totalSpent    = budgetsWithSpend.reduce((s, b) => s + b.spent, 0)

    res.json({ budgets: budgetsWithSpend, totalBudgeted, totalSpent })
  } catch (err) {
    next(err)
  }
})

// POST /api/budgets — create a new budget category
router.post('/', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { name, cap, icon, color, period } = req.body

    if (!name || !cap) {
      return res.status(400).json({ error: 'Name and cap are required' })
    }

    const { rows } = await pool.query(
      `INSERT INTO budgets (user_id, name, cap, icon, color, period)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uid, name, cap, icon || '📦', color || 'safe', period || 'monthly']
    )

    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/budgets/:id — update cap, name, icon, or color
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, cap, icon, color } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (name  !== undefined) { updates.push(`name=$${idx++}`);  values.push(name) }
    if (cap   !== undefined) { updates.push(`cap=$${idx++}`);   values.push(Number(cap)) }
    if (icon  !== undefined) { updates.push(`icon=$${idx++}`);  values.push(icon) }
    if (color !== undefined) { updates.push(`color=$${idx++}`); values.push(color) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE budgets SET ${updates.join(', ')}
       WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Budget not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/budgets/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM budgets WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router

// GET /api/budgets/:id/transactions — transactions for a specific budget category
router.get('/:id/transactions', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: budget } = await pool.query(
      'SELECT * FROM budgets WHERE id=$1 AND user_id=$2',
      [req.params.id, uid]
    )
    if (!budget.length) return res.status(404).json({ error: 'Budget not found' })

    const { rows: transactions } = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id=$1 AND category ILIKE $2 AND amount<0 AND COALESCE(tx_type,'expense') != 'transfer'
         AND date>=date_trunc('month',CURRENT_DATE)
       ORDER BY date DESC, id DESC`,
      [uid, budget[0].name]
    )
    res.json({ transactions })
  } catch (err) {
    next(err)
  }
})

// GET /api/budgets/:id/history — 6-month spend history for sparkline/chart
router.get('/:id/history', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: budget } = await pool.query(
      'SELECT * FROM budgets WHERE id=$1 AND user_id=$2',
      [req.params.id, uid]
    )
    if (!budget.length) return res.status(404).json({ error: 'Budget not found' })

    const { rows: history } = await pool.query(
      `SELECT
         to_char(date_trunc('month', date), 'Mon') AS month,
         date_trunc('month', date) AS month_start,
         ABS(SUM(amount)) AS spent
       FROM transactions
       WHERE user_id=$1
         AND category ILIKE $2
         AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
       GROUP BY date_trunc('month', date)
       ORDER BY month_start ASC`,
      [uid, budget[0].name]
    )

    // Fill in missing months with 0
    const months = []
    for (let i = 5; i >= 0; i--) {
      const d     = new Date()
      d.setMonth(d.getMonth() - i)
      const key   = d.toLocaleString('en-US', { month: 'short' })
      const found = history.find(h => h.month === key)
      months.push({ month: key, spent: found ? Number(found.spent) : 0 })
    }

    res.json({ history: months, cap: Number(budget[0].cap) })
  } catch (err) { next(err) }
})

// PATCH /api/budgets/:id/complete — toggle completed status
router.patch('/:id/complete', async (req, res, next) => {
  try {
    const { completed } = req.body
    const { rows } = await pool.query(
      'UPDATE budgets SET completed=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [completed, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Budget not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// ── Phase C: Budget Intelligence endpoints ────────────────────────────────────

// GET /api/budgets/forecast — EOM prediction + per-budget pace
router.get('/forecast', async (req, res, next) => {
  try {
    const data = await predictEndOfMonth(req.user.id)
    res.json(data)
  } catch (err) { next(err) }
})

// POST /api/budgets/pace-check — manually trigger pace alert check
// (also runs from cron)
router.post('/pace-check', async (req, res, next) => {
  try {
    const fired = await checkPaceAlerts(req.user.id)
    res.json({ success: true, alerts_fired: fired })
  } catch (err) { next(err) }
})

// POST /api/budgets/auto-complete — manually trigger auto-complete check
// (also runs from cron)
router.post('/auto-complete', async (req, res, next) => {
  try {
    const completed = await autoCompleteCategories(req.user.id)
    res.json({ success: true, completed })
  } catch (err) { next(err) }
})
