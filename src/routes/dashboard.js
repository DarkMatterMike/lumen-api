const express      = require('express')
const router       = express.Router()
const pool         = require('../db/pool')
const requireAuth  = require('../middleware/requireAuth')
const { getOccurrencesForMonth } = require('../db/recurringUtils')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id

    const { rows: balanceRows } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN is_debt THEN -balance ELSE balance END), 0) AS balance
       FROM accounts WHERE user_id=$1 AND include_in_balance=TRUE`,
      [uid]
    )
    const balance = Number(balanceRows[0].balance)

    const today    = new Date()
    today.setHours(0, 0, 0, 0)
    const todayDay = today.getDate()
    const year     = today.getFullYear()
    const month    = today.getMonth()

    // Get all active recurring items
    const { rows: allRecurring } = await pool.query(
      'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE',
      [uid]
    )

    // Expand occurrences for this month, filter to on/after today
    const remainingExpenses = []
    const remainingIncome   = []

    for (const r of allRecurring) {
      const dates = getOccurrencesForMonth(r, year, month)
      for (const d of dates) {
        if (d.getDate() >= todayDay) {
          if (r.type === 'income') {
            remainingIncome.push({ ...r, day_of_month: d.getDate(), daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)) })
          } else {
            remainingExpenses.push({ ...r, day_of_month: d.getDate(), daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)) })
          }
        }
      }
    }

    remainingExpenses.sort((a, b) => a.day_of_month - b.day_of_month)
    remainingIncome.sort((a, b) => a.day_of_month - b.day_of_month)

    const committedBills    = remainingExpenses.reduce((s, r) => s + Number(r.amount), 0)
    const upcomingPayTotal  = remainingIncome.reduce((s, r) => s + Number(r.amount), 0)
    const balanceAfterBills = balance - committedBills + upcomingPayTotal

    const { rows: monthSpend } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0) AS spent,
         COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS income
       FROM transactions
       WHERE user_id=$1
         AND date>=date_trunc('month',CURRENT_DATE)
         AND COALESCE(tx_type,'expense') != 'transfer'`,
      [uid]
    )

    // Pressure = bills remaining vs (balance + incoming pay)
    const totalAvailable = balance + upcomingPayTotal
    const pressureScore  = totalAvailable > 0
      ? Math.min(100, Math.round((committedBills / totalAvailable) * 100))
      : 100
    const pressureLabel =
      pressureScore < 20 ? 'SAFE' :
      pressureScore < 45 ? 'WATCH' :
      pressureScore < 70 ? 'TIGHT' : 'CRITICAL'

    const upcomingBills = remainingExpenses.slice(0, 5)
    const nextPaycheck  = remainingIncome[0] || null

    res.json({
      balance, balanceAfterBills, committedBills, upcomingPayTotal,
      pressureScore, pressureLabel,
      monthSpent:  Number(monthSpend[0].spent),
      monthIncome: Number(monthSpend[0].income),
      upcomingBills, nextPaycheck,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
