/**
 * cashFlowForecast.js
 * Phase D — Cash Flow Forecasting
 *
 * Exports:
 *  - buildForecast(userId, days)         → day-by-day balance projection (default 90 days)
 *  - detectCashCrunches(userId)          → find dangerous low-balance windows in next 90 days
 *  - checkTransferSuggestions(userId)    → suggest moving money between accounts if crunch ahead
 *  - runCashFlowAlerts(userId)           → fire notifications for crunches (cron-called)
 */

const pool = require('../db/pool')
const { getOccurrencesForMonth } = require('../db/recurringUtils')

// ── 1. BUILD FORECAST ─────────────────────────────────────────────────────────
/**
 * Builds a day-by-day projection of the user's total liquid balance over `days` days.
 *
 * Model:
 *   - Starts from current liquid balance
 *   - Adds/subtracts each recurring item on its scheduled day(s)
 *   - Subtracts daily discretionary spend pace on every day (excluding days with big income)
 *   - Returns an array of { date, balance, events[] } objects
 *
 * Returns { points, minBalance, minDate, crunches, dailyPace, startBalance }
 */
async function buildForecast(userId, days = 90) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // ── Liquid balance ────────────────────────────────────────────
  const { rows: balRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN is_debt THEN -balance ELSE balance END), 0) AS liquid,
       COALESCE(SUM(CASE WHEN is_debt = FALSE AND LOWER(COALESCE(type,'')) = 'savings' THEN balance ELSE 0 END), 0) AS savings,
       COALESCE(SUM(CASE WHEN is_debt = FALSE AND LOWER(COALESCE(type,'')) IN ('checking','') THEN balance ELSE 0 END), 0) AS checking
     FROM accounts
     WHERE user_id = $1 AND include_in_balance = TRUE`,
    [userId]
  )
  // Fallback: all non-debt accounts
  const { rows: fallback } = await pool.query(
    `SELECT COALESCE(SUM(balance), 0) AS liquid,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(type,'')) = 'savings' THEN balance ELSE 0 END), 0) AS savings
     FROM accounts WHERE user_id = $1 AND COALESCE(is_debt, FALSE) = FALSE`,
    [userId]
  )
  const startBalance = Number(balRows[0]?.liquid) || Number(fallback[0]?.liquid) || 0
  const savingsBalance = Number(balRows[0]?.savings) || Number(fallback[0]?.savings) || 0

  // ── Daily spending pace (last 30 days, excluding income + transfers) ─────────
  const { rows: paceRows } = await pool.query(
    `SELECT COALESCE(SUM(ABS(amount)), 0) AS total_spent
     FROM transactions
     WHERE user_id = $1
       AND amount < 0
       AND COALESCE(tx_type, 'expense') NOT IN ('income', 'transfer')
       AND date >= CURRENT_DATE - INTERVAL '30 days'
       AND date < CURRENT_DATE`,
    [userId]
  )
  const last30Spent = Number(paceRows[0]?.total_spent) || 0
  const dailyPace   = last30Spent / 30

  // ── All active recurring items ────────────────────────────────
  const { rows: allRecurring } = await pool.query(
    'SELECT * FROM recurring WHERE user_id = $1 AND active = TRUE',
    [userId]
  )

  // ── Build event map: date string → list of recurring events ──
  const eventMap = {} // 'YYYY-MM-DD' → [{ name, amount, type, icon }]

  // Span 3 months (covers 90 days regardless of start date)
  for (let mo = 0; mo <= 2; mo++) {
    const d    = new Date(today)
    d.setMonth(d.getMonth() + mo)
    const y    = d.getFullYear()
    const m    = d.getMonth()

    for (const r of allRecurring) {
      const dates = getOccurrencesForMonth(r, y, m)
      for (const occ of dates) {
        if (occ < today) continue
        const key = occ.toISOString().slice(0, 10)
        if (!eventMap[key]) eventMap[key] = []
        eventMap[key].push({
          name:   r.name,
          amount: Number(r.amount),
          type:   r.type || 'expense',
          icon:   r.icon || (r.type === 'income' ? '💰' : '📅'),
          id:     r.id,
        })
      }
    }
  }

  // ── Walk forward day by day ───────────────────────────────────
  const points  = []
  let   running = startBalance

  for (let i = 0; i < days; i++) {
    const d    = new Date(today)
    d.setDate(d.getDate() + i)
    const key  = d.toISOString().slice(0, 10)
    const evts = eventMap[key] || []

    // Apply recurring events
    let dayDelta = 0
    for (const evt of evts) {
      if (evt.type === 'income') dayDelta += evt.amount
      else                       dayDelta -= evt.amount
    }

    // Subtract daily pace (not on income-heavy days — payday offsets it naturally)
    const hasLargeIncome = evts.some(e => e.type === 'income' && e.amount > dailyPace * 3)
    if (!hasLargeIncome) dayDelta -= dailyPace

    running += dayDelta
    points.push({
      date:    key,
      balance: Math.round(running * 100) / 100,
      events:  evts,
      delta:   Math.round(dayDelta * 100) / 100,
    })
  }

  // ── Find minimum & crunches (windows where balance < threshold) ───────────
  const threshold = Math.min(500, startBalance * 0.1) // 10% of current or $500
  const crunches  = findCrunches(points, threshold)

  const minPoint  = points.reduce((a, b) => a.balance < b.balance ? a : b, points[0] || { balance: 0, date: today.toISOString().slice(0,10) })

  return {
    points,
    startBalance,
    savingsBalance,
    dailyPace:    Math.round(dailyPace * 100) / 100,
    minBalance:   minPoint.balance,
    minDate:      minPoint.date,
    crunches,
    threshold,
    days,
  }
}

// ── 2. CRUNCH DETECTION ───────────────────────────────────────────────────────
/**
 * Find windows in the forecast where balance drops below threshold.
 * A "crunch" is a contiguous period of below-threshold balance.
 *
 * Returns array of { startDate, endDate, minBalance, minDate, billsInWindow }
 */
function findCrunches(points, threshold) {
  const crunches = []
  let   inCrunch = false
  let   current  = null

  for (const pt of points) {
    if (pt.balance < threshold && !inCrunch) {
      inCrunch = true
      current  = { startDate: pt.date, endDate: pt.date, minBalance: pt.balance, minDate: pt.date, events: [...pt.events] }
    } else if (pt.balance < threshold && inCrunch) {
      current.endDate = pt.date
      current.events  = [...current.events, ...pt.events]
      if (pt.balance < current.minBalance) {
        current.minBalance = pt.balance
        current.minDate    = pt.date
      }
    } else if (pt.balance >= threshold && inCrunch) {
      crunches.push(current)
      inCrunch = false
      current  = null
    }
  }
  if (inCrunch && current) crunches.push(current)

  return crunches
}

// ── 3. DETECT + NOTIFY CRUNCHES ───────────────────────────────────────────────
/**
 * Run forecast, find crunches, fire one notification per new crunch window.
 * Deduplicated by crunch start date so we don't repeat alerts.
 */
async function runCashFlowAlerts(userId) {
  const { createNotification } = require('../routes/notifications')
  const forecast = await buildForecast(userId, 90)
  let   fired    = 0

  for (const crunch of forecast.crunches) {
    // Only alert for crunches starting in the next 30 days (not distant future)
    const daysUntil = daysBetween(new Date(), new Date(crunch.startDate))
    if (daysUntil > 30) continue

    const alertKey = `crunch-${crunch.startDate}`
    const { rows: existing } = await pool.query(
      'SELECT id FROM cash_crunch_alerts WHERE user_id=$1 AND alert_key=$2',
      [userId, alertKey]
    )
    if (existing.length) continue

    const icon  = crunch.minBalance < 0 ? '🚨' : '⚠️'
    const label = crunch.minBalance < 0 ? 'overdraft risk' : 'tight window'
    const bills = crunch.events.filter(e => e.type !== 'income').slice(0, 3).map(e => e.name).join(', ')

    await createNotification(userId, {
      type:  'warning',
      icon,
      title: `Cash ${label} around ${friendlyDate(crunch.startDate)}`,
      body:  `Your projected balance drops to $${fmt(crunch.minBalance)} around ${friendlyDate(crunch.minDate)}${bills ? `. Bills in this window: ${bills}.` : '.'}${
        crunch.minBalance < 0 ? ' Consider moving money from savings before then.' : ''
      }`,
      metadata: {
        type:        'cash_crunch',
        start_date:  crunch.startDate,
        end_date:    crunch.endDate,
        min_balance: crunch.minBalance,
        min_date:    crunch.minDate,
      }
    })

    await pool.query(
      'INSERT INTO cash_crunch_alerts (user_id, crunch_date, alert_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [userId, crunch.startDate, alertKey]
    )
    fired++
  }

  return { fired, crunches: forecast.crunches.length }
}

// ── 4. TRANSFER SUGGESTIONS ───────────────────────────────────────────────────
/**
 * If a crunch is coming and savings > 0, suggest a specific transfer amount + timing.
 * Returns array of { from_account, to_account, amount, reason, by_date }
 */
async function checkTransferSuggestions(userId) {
  const forecast = await buildForecast(userId, 60)
  const suggestions = []

  if (!forecast.crunches.length) return suggestions
  if (forecast.savingsBalance <= 0) return suggestions

  // Get checking and savings accounts
  const { rows: accounts } = await pool.query(
    `SELECT id, name, balance, type FROM accounts
     WHERE user_id = $1 AND COALESCE(is_debt, FALSE) = FALSE
     ORDER BY balance DESC`,
    [userId]
  )

  const savings  = accounts.find(a => (a.type || '').toLowerCase() === 'savings')
  const checking = accounts.find(a => (a.type || '').toLowerCase() === 'checking' || !a.type)

  if (!savings || !checking) return suggestions

  for (const crunch of forecast.crunches.slice(0, 2)) {
    const daysUntil = daysBetween(new Date(), new Date(crunch.startDate))
    if (daysUntil > 30 || daysUntil < 0) continue

    const deficit = Math.abs(Math.min(0, crunch.minBalance)) + 200 // buffer
    const canMove = Math.min(Number(savings.balance) * 0.5, deficit + 500) // don't drain savings

    if (canMove < 50) continue // not worth suggesting tiny amounts

    suggestions.push({
      from_account:      savings.id,
      from_account_name: savings.name,
      to_account:        checking.id,
      to_account_name:   checking.name,
      amount:            Math.ceil(canMove / 50) * 50, // round up to nearest $50
      reason:            `Projected balance drops to $${fmt(crunch.minBalance)} around ${friendlyDate(crunch.minDate)}`,
      by_date:           crunch.startDate,
      days_until:        daysUntil,
      crunch_min:        crunch.minBalance,
    })
  }

  return suggestions
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000)
}

function friendlyDate(str) {
  if (!str) return ''
  const d = new Date(str + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

module.exports = {
  buildForecast,
  findCrunches,
  runCashFlowAlerts,
  checkTransferSuggestions,
}
