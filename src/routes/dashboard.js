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

    // Rolling 30-day window — crosses month boundary so Rent on the 1st
    // shows up when it's still the 28th of the prior month.
    const window30End = new Date(today)
    window30End.setDate(window30End.getDate() + 30)

    const remainingExpenses = []
    const remainingIncome   = []

    // Check this month AND next month to cover the rolling window
    for (const monthOffset of [0, 1]) {
      const y = month + monthOffset > 11 ? year + 1 : year
      const m = (month + monthOffset) % 12
      for (const r of allRecurring) {
        const dates = getOccurrencesForMonth(r, y, m)
        for (const d of dates) {
          // Include only dates from today through today+30 days
          if (d >= today && d <= window30End) {
            const daysUntil = Math.max(0, Math.ceil((d - today) / 86400000))
            const entry = { ...r, _date: d, day_of_month: d.getDate(), month: m, daysUntil }
            if (r.type === 'income') {
              remainingIncome.push(entry)
            } else {
              remainingExpenses.push(entry)
            }
          }
        }
      }
    }

    // Sort by actual date
    remainingExpenses.sort((a, b) => a._date - b._date)
    remainingIncome.sort((a, b) => a._date - b._date)

    const committedBills    = remainingExpenses.reduce((s, r) => s + Number(r.amount), 0)
    const upcomingPayTotal  = remainingIncome.reduce((s, r) => s + Number(r.amount), 0)

    // Hero = current spendable (balance minus bills in next 30 days)
    // Income is shown in narrative but not added to hero — user hasn't earned it yet
    const freeToSpend       = balance - committedBills
    const balanceAfterBills = freeToSpend  // for compatibility
    const nextBillCluster   = remainingExpenses.slice(0, 3)  // nearest 3 bills for narrative

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

    // Active pinned plans — direction +1 = new cost (subtract), -1 = saving/skip (add back)
    const { rows: activePlans } = await pool.query(
      `SELECT * FROM plans WHERE user_id=$1 AND status='active' ORDER BY created_at DESC`,
      [uid]
    )
    const planImpact      = activePlans.reduce((s, p) => s + Number(p.amount || 0) * Number(p.direction ?? 1), 0)
    const plannedSpend    = activePlans.filter(p => Number(p.direction ?? 1) > 0).reduce((s, p) => s + Number(p.amount || 0), 0)
    const plannedSavings  = activePlans.filter(p => Number(p.direction ?? 1) < 0).reduce((s, p) => s + Number(p.amount || 0), 0)
    const balanceAfterPlans = balanceAfterBills - planImpact

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
    const next3Bills    = nextBillCluster
    const bills30Days   = committedBills
    const income30Days  = upcomingPayTotal

    res.json({
      balance, freeToSpend, balanceAfterBills, balanceAfterPlans, committedBills, upcomingPayTotal, bills30Days, income30Days,
      pressureScore, pressureLabel,
      monthSpent:  Number(monthSpend[0].spent),
      monthIncome: Number(monthSpend[0].income),
      upcomingBills, nextPaycheck, next3Bills,
      activePlans,
      plannedSpend,
      plannedSavings,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
