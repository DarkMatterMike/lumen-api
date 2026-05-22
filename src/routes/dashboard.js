const express      = require('express')
const router       = express.Router()
const pool         = require('../db/pool')
const requireAuth  = require('../middleware/requireAuth')
const { getOccurrencesForMonth } = require('../db/recurringUtils')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id

    // ── Balance ──────────────────────────────────────────────
    const { rows: balanceRows } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN is_debt THEN -balance ELSE balance END), 0) AS balance
       FROM accounts WHERE user_id=$1 AND include_in_balance=TRUE`,
      [uid]
    )
    const balance = Number(balanceRows[0].balance)

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // ── All active recurring items ────────────────────────────
    const { rows: allRecurring } = await pool.query(
      'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE',
      [uid]
    )

    // ── Gather all occurrences in the next 90 days ────────────
    // 90 days covers 3 months so we never miss a pay period
    const horizonEnd = new Date(today)
    horizonEnd.setDate(horizonEnd.getDate() + 90)

    const allOccurrences = []
    for (const monthOffset of [0, 1, 2]) {
      const d = new Date(today)
      d.setDate(1)
      d.setMonth(d.getMonth() + monthOffset)
      const y = d.getFullYear()
      const m = d.getMonth()
      for (const r of allRecurring) {
        const dates = getOccurrencesForMonth(r, y, m)
        for (const date of dates) {
          if (date >= today && date <= horizonEnd) {
            allOccurrences.push({ ...r, _date: date, daysUntil: Math.ceil((date - today) / 86400000) })
          }
        }
      }
    }
    allOccurrences.sort((a, b) => a._date - b._date)

    const allIncome   = allOccurrences.filter(r => r.type === 'income')
    const allExpenses = allOccurrences.filter(r => r.type !== 'income')

    // ── Build pay-period windows ──────────────────────────────
    // Window 0: today → day before first upcoming paycheck (or 30 days if no paycheck)
    // Window 1: first paycheck day → day before second paycheck (or 30 days out)
    // Window 2: second paycheck → day before third paycheck
    // etc.  We return up to 4 windows.

    // Paychecks that are today OR in the future (today counts — already landed)
    const paychecks = allIncome.filter(r => r._date >= today)

    // Build window boundary dates: [today, pay1, pay2, pay3, ...]
    // Cap at 90 days so windows don't run forever
    const windowStarts = [new Date(today)]
    for (const p of paychecks.slice(0, 3)) {
      // Only add as a boundary if it's strictly after the prior boundary
      const last = windowStarts[windowStarts.length - 1]
      if (p._date > last) windowStarts.push(new Date(p._date))
    }

    function buildWindow(startDate, endDate, index) {
      // Paychecks that land on startDate (already in pocket on startDate)
      const paychecksOnStart = allIncome.filter(r =>
        r._date.getTime() === startDate.getTime()
      )
      // Paychecks that arrive strictly WITHIN this window (after start, before end)
      const paychecksInWindow = allIncome.filter(r =>
        r._date > startDate && r._date < endDate
      )
      // Bills due in [startDate, endDate] — INCLUSIVE of endDate.
      // Bills on paycheck day still need to be covered before that money arrives.
      const billsInWindow = allExpenses.filter(r =>
        r._date >= startDate && r._date <= endDate
      )

      const paycheckOnStartTotal = paychecksOnStart.reduce((s, r) => s + Number(r.amount), 0)
      const paychecksInTotal     = paychecksInWindow.reduce((s, r) => s + Number(r.amount), 0)
      const billsTotal           = billsInWindow.reduce((s, r) => s + Number(r.amount), 0)

      // Next paycheck = the one that ends this window (if any)
      const nextPay = paychecks.find(r => r._date.getTime() === endDate.getTime()) || null

      // Days until window ends
      const daysUntilEnd = nextPay ? Math.ceil((endDate - today) / 86400000) : null

      return {
        index,
        startDate: startDate.toISOString().slice(0, 10),
        endDate:   endDate.toISOString().slice(0, 10),
        // Money available at the start of this window
        openingBalance: index === 0 ? balance : null,  // only meaningful for window 0
        paychecksOnStart,        // landed today (window 0 only)
        paychecksInWindow,       // arrive during window
        paycheckOnStartTotal,
        paychecksInTotal,
        billsInWindow,
        billsTotal,
        nextPay,                 // the paycheck that ends this window
        daysUntilEnd,
      }
    }

    const windows = []
    for (let i = 0; i < windowStarts.length; i++) {
      const start = windowStarts[i]
      // End = start of next window, or 30 days from this start if no next window
      const end = windowStarts[i + 1] || (() => {
        const d = new Date(start)
        d.setDate(d.getDate() + 30)
        return d
      })()
      windows.push(buildWindow(start, end, i))
    }

    // ── Window 0 hero metrics ─────────────────────────────────
    const w0 = windows[0]

    // Free to spend in the current window:
    // balance + paychecks that landed today - bills before next paycheck
    const freeToSpendNow = balance + w0.paycheckOnStartTotal - w0.billsTotal

    // Legacy fields (kept for compatibility with other parts of the app)
    const committedBills   = allExpenses.slice(0).reduce((s, r) => s + Number(r.amount), 0)  // 30-day total
    const upcomingPayTotal = allIncome.reduce((s, r) => s + Number(r.amount), 0)
    const bills30Days      = allExpenses.filter(r => r.daysUntil <= 30).reduce((s, r) => s + Number(r.amount), 0)
    const income30Days     = upcomingPayTotal

    // ── Pressure score ────────────────────────────────────────
    // Based on current window only (most relevant to user right now)
    const windowAvailable = balance + w0.paycheckOnStartTotal
    const pressureScore = windowAvailable > 0
      ? Math.min(100, Math.round((w0.billsTotal / windowAvailable) * 100))
      : w0.billsTotal > 0 ? 100 : 0
    const pressureLabel =
      pressureScore < 20 ? 'SAFE' :
      pressureScore < 45 ? 'WATCH' :
      pressureScore < 70 ? 'TIGHT' : 'CRITICAL'

    // ── Month spend ───────────────────────────────────────────
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

    // ── Plans ─────────────────────────────────────────────────
    const { rows: activePlans } = await pool.query(
      `SELECT * FROM plans WHERE user_id=$1 AND status='active' ORDER BY created_at DESC`,
      [uid]
    )
    const planImpact        = activePlans.reduce((s, p) => s + Number(p.amount || 0) * Number(p.direction ?? 1), 0)
    const plannedSpend      = activePlans.filter(p => Number(p.direction ?? 1) > 0).reduce((s, p) => s + Number(p.amount || 0), 0)
    const plannedSavings    = activePlans.filter(p => Number(p.direction ?? 1) < 0).reduce((s, p) => s + Number(p.amount || 0), 0)
    const balanceAfterBills = freeToSpendNow
    const balanceAfterPlans = freeToSpendNow - planImpact

    const nextPaycheck  = w0.nextPay || allIncome[0] || null
    const upcomingBills = allExpenses.slice(0, 5)
    const next3Bills    = allExpenses.slice(0, 3)

    res.json({
      // Core
      balance,
      freeToSpend:       freeToSpendNow,
      balanceAfterBills: freeToSpendNow,
      balanceAfterPlans,
      committedBills:    w0.billsTotal,      // current window bills (used in hero)
      committedBills30:  bills30Days,        // 30-day total (for reference)
      upcomingPayTotal,
      bills30Days,
      income30Days,

      // Pay-period windows (the core new data)
      windows,

      // Pressure
      pressureScore,
      pressureLabel,

      // Month
      monthSpent:  Number(monthSpend[0].spent),
      monthIncome: Number(monthSpend[0].income),

      // Lists
      upcomingBills,
      nextPaycheck,
      next3Bills,

      // Plans
      activePlans,
      plannedSpend,
      plannedSavings,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
