const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id

    const { rows: cashFlow } = await pool.query(
      `SELECT
         TO_CHAR(date_trunc('month',date),'Mon') AS month,
         date_trunc('month',date) AS month_date,
         COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS income,
         COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0) AS spending
       FROM transactions
       WHERE user_id=$1 AND date>=date_trunc('month',CURRENT_DATE)-INTERVAL '5 months'
       GROUP BY date_trunc('month',date)
       ORDER BY month_date ASC`,
      [uid]
    )

    const { rows: byCategory } = await pool.query(
      `SELECT category, SUM(ABS(amount)) AS total
       FROM transactions
       WHERE user_id=$1 AND amount<0 AND date>=date_trunc('month',CURRENT_DATE)
       GROUP BY category ORDER BY total DESC`,
      [uid]
    )

    const { rows: kpis } = await pool.query(
      `SELECT AVG(monthly_spend) AS avg_monthly_spend, AVG(monthly_income) AS avg_monthly_income
       FROM (
         SELECT
           date_trunc('month',date) AS m,
           SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) AS monthly_spend,
           SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS monthly_income
         FROM transactions
         WHERE user_id=$1 AND date>=date_trunc('month',CURRENT_DATE)-INTERVAL '3 months'
         GROUP BY date_trunc('month',date)
       ) sub`,
      [uid]
    )

    const { rows: savings } = await pool.query(
      "SELECT balance FROM accounts WHERE user_id=$1 AND type='savings' LIMIT 1",
      [uid]
    )

    const savingsBalance = savings.length ? Number(savings[0].balance) : 0
    const avgIncome      = Number(kpis[0]?.avg_monthly_income || 0)
    const avgSpend       = Number(kpis[0]?.avg_monthly_spend  || 0)
    const savingsRate    = avgIncome > 0
      ? Math.round(((avgIncome - avgSpend) / avgIncome) * 100)
      : 0

    res.json({
      cashFlow, byCategory,
      kpis: { avgMonthlySpend: Math.round(avgSpend), savingsRate, savingsBalance },
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
