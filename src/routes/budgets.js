const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

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

module.exports = router
