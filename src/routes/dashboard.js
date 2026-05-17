const express = require('express')
const router = express.Router()
const pool = require('../db/pool')

// GET /api/dashboard — everything the dashboard needs in one call
router.get('/', async (req, res, next) => {
  try {
    // 1. Primary checking account balance
    const { rows: checking } = await pool.query(
      "SELECT * FROM accounts WHERE type = 'checking' LIMIT 1"
    )
    const balance = checking.length ? Number(checking[0].balance) : 0

    // 2. Upcoming bills this month
    const today = new Date()
    const todayDay = today.getDate()

    const { rows: recurring } = await pool.query(
      "SELECT * FROM recurring WHERE active = TRUE AND type != 'income' AND day_of_month >= $1 ORDER BY day_of_month ASC",
      [todayDay]
    )

    const committedBills = recurring.reduce((s, r) => s + Number(r.amount), 0)
    const balanceAfterBills = balance - committedBills

    // 3. Next paycheck
    const { rows: nextPay } = await pool.query(
      "SELECT * FROM recurring WHERE active = TRUE AND type = 'income' AND day_of_month >= $1 ORDER BY day_of_month ASC LIMIT 1",
      [todayDay]
    )

    // 4. This month's spending (What Happened)
    const { rows: monthSpend } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS spent,
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income
      FROM transactions
      WHERE date >= date_trunc('month', CURRENT_DATE)
    `)

    // 5. Pressure score (0-100, higher = more pressure)
    // Simple formula: committed bills as % of balance
    const pressureScore = balance > 0
      ? Math.min(100, Math.round((committedBills / balance) * 100))
      : 100

    const pressureLabel =
      pressureScore < 25 ? 'SAFE' :
      pressureScore < 50 ? 'WATCH' :
      pressureScore < 75 ? 'TIGHT' : 'CRITICAL'

    // 6. Upcoming bills list for sidebar
    const upcomingBills = recurring.slice(0, 5).map(r => {
      const eventDate = new Date(today.getFullYear(), today.getMonth(), r.day_of_month)
      const daysUntil = Math.max(0, Math.ceil((eventDate - today) / 86400000))
      return { ...r, daysUntil }
    })

    // 7. Next income event
    const nextPayData = nextPay.length ? (() => {
      const d = new Date(today.getFullYear(), today.getMonth(), nextPay[0].day_of_month)
      return { ...nextPay[0], daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)), date: d }
    })() : null

    res.json({
      balance,
      balanceAfterBills,
      committedBills,
      pressureScore,
      pressureLabel,
      monthSpent: Number(monthSpend[0].spent),
      monthIncome: Number(monthSpend[0].income),
      upcomingBills,
      nextPaycheck: nextPayData,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
