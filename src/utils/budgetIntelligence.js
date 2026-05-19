/**
 * budgetIntelligence.js
 * Phase C — Budget Intelligence
 *
 * Exports:
 *  - predictEndOfMonth(userId)          → projected balance + per-budget pace data
 *  - checkPaceAlerts(userId)            → fires notifications for budgets on pace to breach
 *  - autoCompleteCategories(userId)     → marks budget categories done when all expected charges cleared
 */

const pool = require('../db/pool')
const { getOccurrencesForMonth } = require('../db/recurringUtils')

// ── 1. END-OF-MONTH BALANCE PREDICTION ───────────────────────────────────────
/**
 * Projects end-of-month balance based on:
 *   - Current liquid balance
 *   - Remaining bills this month
 *   - Upcoming income this month
 *   - Daily spending pace (this month so far → extrapolated)
 *   - Remaining discretionary days
 *
 * Returns a rich object the frontend and cron jobs can both use.
 */
async function predictEndOfMonth(userId) {
  const today      = new Date()
  today.setHours(0, 0, 0, 0)
  const todayDay   = today.getDate()
  const year       = today.getFullYear()
  const month      = today.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysLeft   = daysInMonth - todayDay
  const daysPassed = todayDay - 1 // days elapsed before today

  // Current liquid balance (include_in_balance accounts)
  const { rows: balRows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN is_debt THEN -balance ELSE balance END), 0) AS balance
     FROM accounts WHERE user_id=$1 AND include_in_balance=TRUE`,
    [userId]
  )
  // Fallback to all non-debt liquid if none toggled
  const { rows: fallbackRows } = Number(balRows[0]?.balance) !== 0 ? { rows: [] } : await pool.query(
    `SELECT COALESCE(SUM(balance), 0) AS balance
     FROM accounts WHERE user_id=$1 AND is_debt=FALSE AND type IN ('checking','savings')`,
    [userId]
  )
  const currentBalance = Number(balRows[0]?.balance || fallbackRows[0]?.balance || 0)

  // This month's spending so far (expenses only, exclude transfers)
  const { rows: spendRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN amount < 0 AND COALESCE(tx_type,'expense') != 'transfer' THEN ABS(amount) ELSE 0 END), 0) AS spent,
       COALESCE(SUM(CASE WHEN amount > 0 AND COALESCE(tx_type,'expense') != 'transfer' THEN amount ELSE 0 END), 0) AS income_received
     FROM transactions
     WHERE user_id=$1 AND date >= date_trunc('month', CURRENT_DATE)`,
    [userId]
  )
  const spentSoFar     = Number(spendRows[0].spent)
  const incomeReceived = Number(spendRows[0].income_received)

  // Daily spending pace (avoid div/0 for early month)
  const dailyPace = daysPassed > 0 ? spentSoFar / daysPassed : spentSoFar

  // Remaining recurring items this month
  const { rows: allRecurring } = await pool.query(
    'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE',
    [userId]
  )

  let remainingBills  = 0
  let remainingIncome = 0
  const upcomingItems = []

  for (const r of allRecurring) {
    const dates = getOccurrencesForMonth(r, year, month)
    for (const d of dates) {
      if (d.getDate() > todayDay) {
        if (r.type === 'income') {
          remainingIncome += Number(r.amount)
        } else {
          remainingBills += Number(r.amount)
        }
        upcomingItems.push({
          name:       r.name,
          amount:     Number(r.amount),
          type:       r.type,
          day:        d.getDate(),
          daysUntil:  d.getDate() - todayDay,
        })
      }
    }
  }

  // Projected discretionary spend for remaining days (pace-based)
  const projectedDiscretionary = dailyPace * daysLeft

  // Projected EOM balance
  const projectedBalance = currentBalance
    + remainingIncome
    - remainingBills
    - projectedDiscretionary

  // Per-budget pace data
  const { rows: budgets } = await pool.query(
    `SELECT b.id, b.name, b.cap, b.icon, b.color, b.completed,
       COALESCE(SUM(CASE WHEN t.amount < 0 AND COALESCE(t.tx_type,'expense') != 'transfer'
         THEN ABS(t.amount) ELSE 0 END), 0) AS spent
     FROM budgets b
     LEFT JOIN transactions t
       ON t.user_id = b.user_id
       AND LOWER(t.category) = LOWER(b.name)
       AND t.date >= date_trunc('month', CURRENT_DATE)
     WHERE b.user_id = $1
     GROUP BY b.id, b.name, b.cap, b.icon, b.color, b.completed`,
    [userId]
  )

  const budgetPace = budgets.map(b => {
    const spent       = Number(b.spent)
    const cap         = Number(b.cap)
    const pct         = cap > 0 ? (spent / cap) * 100 : 0
    // Daily pace for this category
    const catDailyPace = daysPassed > 0 ? spent / daysPassed : spent
    const projectedSpend = spent + (catDailyPace * daysLeft)
    const projectedPct   = cap > 0 ? (projectedSpend / cap) * 100 : 0
    const onPaceToBreach = !b.completed && projectedSpend > cap && cap > 0

    return {
      id:            b.id,
      name:          b.name,
      icon:          b.icon,
      color:         b.color,
      cap,
      spent,
      pct:           Math.round(pct),
      projectedSpend: Math.round(projectedSpend * 100) / 100,
      projectedPct:  Math.round(projectedPct),
      onPaceToBreach,
      dailyPace:     Math.round(catDailyPace * 100) / 100,
      daysLeft,
      completed:     b.completed,
    }
  })

  return {
    currentBalance,
    projectedBalance:       Math.round(projectedBalance * 100) / 100,
    spentSoFar,
    incomeReceived,
    remainingBills,
    remainingIncome,
    projectedDiscretionary: Math.round(projectedDiscretionary * 100) / 100,
    dailyPace:              Math.round(dailyPace * 100) / 100,
    daysLeft,
    daysInMonth,
    todayDay,
    upcomingItems:          upcomingItems.sort((a, b) => a.daysUntil - b.daysUntil),
    budgetPace,
  }
}

// ── 2. PACE ALERTS ────────────────────────────────────────────────────────────
/**
 * Checks each budget category against its pace.
 * Fires a notification if a category is on pace to exceed its cap,
 * but only once per budget per calendar month (tracked in budget_pace_alerts).
 *
 * Thresholds:
 *   - On pace to exceed 100%: fire alert
 *   - Already at 80%+ with >5 days left: fire warning (softer)
 */
async function checkPaceAlerts(userId) {
  const { createNotification } = require('../routes/notifications')
  const prediction = await predictEndOfMonth(userId)
  const monthKey   = new Date().toISOString().slice(0, 7) // 'YYYY-MM'
  let fired = 0

  for (const b of prediction.budgetPace) {
    if (b.completed || b.cap <= 0) continue

    // Has a pace alert already been fired for this budget this month?
    const { rows: existing } = await pool.query(
      `SELECT id FROM budget_pace_alerts
       WHERE user_id=$1 AND budget_id=$2 AND month=$3`,
      [userId, b.id, monthKey]
    )
    if (existing.length) continue

    let shouldAlert = false
    let title, body, icon, type

    if (b.onPaceToBreach) {
      // Projected to exceed cap
      const overage = b.projectedSpend - b.cap
      shouldAlert = true
      type  = 'warning'
      icon  = '📊'
      title = `${b.icon || ''} ${b.name} on pace to go over`.trim()
      body  = `At your current pace you'll spend $${fmt(b.projectedSpend)} in ${b.name} this month — $${fmt(overage)} over your $${fmt(b.cap)} cap. ${b.daysLeft} days left.`
    } else if (b.pct >= 80 && b.daysLeft > 5) {
      // Already 80%+ used with significant days remaining
      shouldAlert = true
      type  = 'warning'
      icon  = '⚠️'
      title = `${b.icon || ''} ${b.name} at ${b.pct}% with ${b.daysLeft} days left`.trim()
      body  = `$${fmt(b.spent)} of $${fmt(b.cap)} used. $${fmt(b.cap - b.spent)} remaining for ${b.daysLeft} more days.`
    }

    if (shouldAlert) {
      await createNotification(userId, { type, title, body, icon,
        metadata: { budget_id: b.id, budget_name: b.name, pct: b.pct, projected_pct: b.projectedPct }
      })
      // Record that we fired this month so we don't repeat
      await pool.query(
        `INSERT INTO budget_pace_alerts (user_id, budget_id, month) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, budget_id, month) DO NOTHING`,
        [userId, b.id, monthKey]
      )
      fired++
    }
  }

  return fired
}

// ── 3. AUTO-COMPLETE CATEGORIES ───────────────────────────────────────────────
/**
 * Auto-marks a budget category as completed when:
 *   - Every recurring item that maps to this category has been seen this month
 *   - AND the category has no remaining expected recurring charges
 *   - AND the cap is at least 50% used (confirms real activity, not just no spending)
 *
 * "Maps to" = recurring item name normalized matches budget category name,
 * OR recurring item's category hint matches.
 *
 * Only auto-completes categories that are NOT already manually completed.
 */
async function autoCompleteCategories(userId) {
  const today      = new Date()
  const year       = today.getFullYear()
  const month      = today.getMonth()
  const todayDay   = today.getDate()

  const { rows: budgets } = await pool.query(
    `SELECT b.id, b.name, b.cap,
       COALESCE(SUM(CASE WHEN t.amount < 0 AND COALESCE(t.tx_type,'expense') != 'transfer'
         THEN ABS(t.amount) ELSE 0 END), 0) AS spent
     FROM budgets b
     LEFT JOIN transactions t
       ON t.user_id = b.user_id
       AND LOWER(t.category) = LOWER(b.name)
       AND t.date >= date_trunc('month', CURRENT_DATE)
     WHERE b.user_id = $1 AND b.completed = FALSE
     GROUP BY b.id, b.name, b.cap`,
    [userId]
  )

  const { rows: allRecurring } = await pool.query(
    'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE AND type != $2',
    [userId, 'income']
  )

  let completed = 0

  for (const budget of budgets) {
    const spent = Number(budget.spent)
    const cap   = Number(budget.cap)
    if (cap <= 0 || spent / cap < 0.5) continue // skip if less than 50% used

    // Find recurring items that belong to this budget category
    const relatedRecurring = allRecurring.filter(r => {
      const rName = (r.name || '').toLowerCase()
      const bName = (budget.name || '').toLowerCase()
      return rName.includes(bName) || bName.includes(rName) ||
        (r.category && r.category.toLowerCase() === bName)
    })

    if (!relatedRecurring.length) continue // no recurring items to check

    // Check if all related recurring items have cleared this month
    let allCleared = true
    for (const r of relatedRecurring) {
      const occurrences = getOccurrencesForMonth(r, year, month)
      for (const occ of occurrences) {
        if (occ.getDate() > todayDay) {
          // This occurrence hasn't happened yet this month
          allCleared = false
          break
        }
        // Check if a matching transaction exists this month
        const { rows: matches } = await pool.query(
          `SELECT id FROM transactions
           WHERE user_id=$1
             AND LOWER(name) LIKE $2
             AND ABS(amount - $3) < 1.00
             AND date >= date_trunc('month', CURRENT_DATE)
             AND date <= CURRENT_DATE
           LIMIT 1`,
          [userId, `%${(r.name || '').toLowerCase().substring(0, 15)}%`, Number(r.amount)]
        )
        if (!matches.length) {
          allCleared = false
          break
        }
      }
      if (!allCleared) break
    }

    if (allCleared) {
      await pool.query(
        'UPDATE budgets SET completed=TRUE WHERE id=$1 AND user_id=$2',
        [budget.id, userId]
      )

      const { createNotification } = require('../routes/notifications')
      await createNotification(userId, {
        type:  'win',
        icon:  '✅',
        title: `${budget.name} auto-completed`,
        body:  `All expected ${budget.name} charges for ${monthName()} have cleared. Category marked done.`,
        metadata: { budget_id: budget.id }
      })
      completed++
    }
  }

  return completed
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function monthName() {
  return new Date().toLocaleString('en-US', { month: 'long' })
}

module.exports = {
  predictEndOfMonth,
  checkPaceAlerts,
  autoCompleteCategories,
}
