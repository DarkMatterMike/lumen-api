const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

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
           WHERE user_id=$1 AND category ILIKE $2 AND amount<0
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
       WHERE user_id=$1 AND category ILIKE $2 AND amount<0
         AND date>=date_trunc('month',CURRENT_DATE)
       ORDER BY date DESC, id DESC`,
      [uid, budget[0].name]
    )
    res.json({ transactions })
  } catch (err) {
    next(err)
  }
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
