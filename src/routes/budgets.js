const express = require('express')
const router = express.Router()
const pool = require('../db/pool')

// GET /api/budgets — all budgets with current month spending
router.get('/', async (req, res, next) => {
  try {
    const { rows: budgets } = await pool.query('SELECT * FROM budgets ORDER BY cap DESC')

    // For each budget, sum this month's spending in that category
    const budgetsWithSpend = await Promise.all(
      budgets.map(async (budget) => {
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(ABS(amount)), 0) AS spent
           FROM transactions
           WHERE category ILIKE $1
             AND amount < 0
             AND date >= date_trunc('month', CURRENT_DATE)`,
          [budget.name]
        )
        return {
          ...budget,
          spent: Number(rows[0].spent),
          pct: Math.round((Number(rows[0].spent) / Number(budget.cap)) * 100),
        }
      })
    )

    // Total budgeted vs total spent this month
    const totalBudgeted = budgets.reduce((s, b) => s + Number(b.cap), 0)
    const totalSpent = budgetsWithSpend.reduce((s, b) => s + b.spent, 0)

    res.json({ budgets: budgetsWithSpend, totalBudgeted, totalSpent })
  } catch (err) {
    next(err)
  }
})

module.exports = router
