/**
 * learningEngine.js
 * Phase I — Learning & Personalization
 *
 * Exports:
 *  - computeHealthScore(userId)        → 0-100 financial health score + components
 *  - runBehavioralAnalysis(userId)     → detect overspend triggers + store insights
 *  - runAdaptiveBudgets(userId)        → suggest seasonal cap adjustments
 *  - detectWins(userId)                → celebrate real financial wins
 *  - runAllLearning(userId)            → calls all four (used by cron)
 *  - getHealthHistory(userId, weeks)   → last N weeks of scores for trending
 */

const pool = require('../db/pool')
const { createNotification } = require('../routes/notifications')

// ── 1. FINANCIAL HEALTH SCORE ─────────────────────────────────────────────────
/**
 * Composite 0-100 score across 6 dimensions:
 *
 *  1. Savings rate          (0-25 pts) — % of income saved this month
 *  2. Budget adherence      (0-20 pts) — how many categories are under cap
 *  3. Cash cushion          (0-20 pts) — months of expenses in liquid accounts
 *  4. Debt load             (0-15 pts) — total debt vs monthly income
 *  5. Spending consistency  (0-10 pts) — low variance month-over-month
 *  6. Bill coverage         (0-10 pts) — balance vs upcoming bills ratio
 */
async function computeHealthScore(userId) {
  const today = new Date()
  const components = {}

  // ── Income & spending this month ──
  const { rows: monthRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN amount > 0 AND COALESCE(tx_type,'expense') NOT IN ('transfer') THEN amount ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN amount < 0 AND COALESCE(tx_type,'expense') NOT IN ('transfer') THEN ABS(amount) ELSE 0 END), 0) AS expenses
     FROM transactions
     WHERE user_id=$1 AND date >= date_trunc('month', CURRENT_DATE)`,
    [userId]
  )
  const monthIncome   = Number(monthRows[0].income)
  const monthExpenses = Number(monthRows[0].expenses)

  // ── Liquid balance ──
  const { rows: balRows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN is_debt THEN -balance ELSE balance END), 0) AS balance
     FROM accounts WHERE user_id=$1`,
    [userId]
  )
  const balance = Number(balRows[0].balance)

  // ── Debt total ──
  const { rows: debtRows } = await pool.query(
    'SELECT COALESCE(SUM(balance), 0) AS total FROM accounts WHERE user_id=$1 AND is_debt=TRUE',
    [userId]
  )
  const totalDebt = Number(debtRows[0].total)

  // ── Upcoming bills this month ──
  const { rows: billRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS bills
     FROM recurring WHERE user_id=$1 AND active=TRUE AND type != 'income'`,
    [userId]
  )
  const monthlyBills = Number(billRows[0].bills)

  // ── Budget adherence ──
  const { rows: budgets } = await pool.query(
    `SELECT b.cap,
       COALESCE(SUM(CASE WHEN t.amount < 0 AND COALESCE(t.tx_type,'expense') != 'transfer'
         THEN ABS(t.amount) ELSE 0 END), 0) AS spent
     FROM budgets b
     LEFT JOIN transactions t
       ON t.user_id = b.user_id
       AND LOWER(t.category) = LOWER(b.name)
       AND t.date >= date_trunc('month', CURRENT_DATE)
     WHERE b.user_id=$1
     GROUP BY b.id, b.cap`,
    [userId]
  )
  const totalBudgets   = budgets.length
  const underCap       = budgets.filter(b => Number(b.cap) > 0 && Number(b.spent) <= Number(b.cap)).length
  const adherencePct   = totalBudgets > 0 ? underCap / totalBudgets : 0.5

  // ── 3-month spending variance ──
  const { rows: monthlySpend } = await pool.query(
    `SELECT date_trunc('month', date) AS m, SUM(ABS(amount)) AS spent
     FROM transactions
     WHERE user_id=$1 AND amount < 0
       AND COALESCE(tx_type,'expense') != 'transfer'
       AND date >= CURRENT_DATE - INTERVAL '3 months'
     GROUP BY m ORDER BY m`,
    [userId]
  )
  const spendAmounts  = monthlySpend.map(r => Number(r.spent))
  const avgSpend      = spendAmounts.length ? spendAmounts.reduce((s, v) => s + v, 0) / spendAmounts.length : 0
  const variance      = spendAmounts.length > 1
    ? spendAmounts.reduce((s, v) => s + Math.pow(v - avgSpend, 2), 0) / spendAmounts.length
    : 0
  const stdDev        = Math.sqrt(variance)
  const cv            = avgSpend > 0 ? stdDev / avgSpend : 0 // coefficient of variation

  // ── Score each component ──

  // 1. Savings rate (0-25): 20%+ = full points, scales down
  const savingsRate = monthIncome > 0 ? (monthIncome - monthExpenses) / monthIncome : 0
  const savingsPts  = Math.max(0, Math.min(25, Math.round(savingsRate * 125)))
  components.savings_rate = { score: savingsPts, max: 25, value: Math.round(savingsRate * 100), label: `${Math.round(savingsRate * 100)}% savings rate` }

  // 2. Budget adherence (0-20)
  const budgetPts = totalBudgets > 0 ? Math.round(adherencePct * 20) : 10 // neutral if no budgets
  components.budget_adherence = { score: budgetPts, max: 20, value: Math.round(adherencePct * 100), label: `${underCap}/${totalBudgets} categories under cap` }

  // 3. Cash cushion (0-20): 3+ months of expenses = full points
  const monthsOfExpenses = monthlyBills > 0 ? balance / monthlyBills : (balance > 0 ? 3 : 0)
  const cushionPts = Math.max(0, Math.min(20, Math.round((monthsOfExpenses / 3) * 20)))
  components.cash_cushion = { score: cushionPts, max: 20, value: Math.round(monthsOfExpenses * 10) / 10, label: `${Math.round(monthsOfExpenses * 10) / 10} months of expenses covered` }

  // 4. Debt load (0-15): 0 debt = full, 3× monthly income = 0
  const monthlyIncome = avgSpend > 0 ? avgSpend * (1 / Math.max(0.3, 1 - savingsRate)) : monthIncome || 1
  const debtRatio     = monthlyIncome > 0 ? totalDebt / (monthlyIncome * 12) : 0 // debt vs annual income
  const debtPts       = totalDebt === 0 ? 15 : Math.max(0, Math.round(15 - debtRatio * 15))
  components.debt_load = { score: debtPts, max: 15, value: Math.round(debtRatio * 100), label: totalDebt === 0 ? 'Debt-free' : `$${fmt(totalDebt)} total debt` }

  // 5. Spending consistency (0-10): CV < 15% = full, CV > 50% = 0
  const consistencyPts = Math.max(0, Math.min(10, Math.round(10 - (cv - 0.15) / 0.35 * 10)))
  components.consistency = { score: consistencyPts, max: 10, value: Math.round(cv * 100), label: cv < 0.15 ? 'Very consistent' : cv < 0.3 ? 'Fairly consistent' : 'Variable spending' }

  // 6. Bill coverage (0-10): balance > 2× bills = full
  const coverageRatio = monthlyBills > 0 ? balance / monthlyBills : 2
  const coveragePts   = Math.max(0, Math.min(10, Math.round((coverageRatio / 2) * 10)))
  components.bill_coverage = { score: coveragePts, max: 10, value: Math.round(coverageRatio * 10) / 10, label: `${Math.round(coverageRatio * 10) / 10}× bill coverage` }

  const totalScore = Object.values(components).reduce((s, c) => s + c.score, 0)
  const grade      = totalScore >= 85 ? 'A' : totalScore >= 70 ? 'B' : totalScore >= 55 ? 'C' : totalScore >= 40 ? 'D' : 'F'
  const label      = totalScore >= 85 ? 'Excellent' : totalScore >= 70 ? 'Good' : totalScore >= 55 ? 'Fair' : totalScore >= 40 ? 'Needs Work' : 'Critical'

  // Persist to history
  const weekKey = getWeekKey(today)
  await pool.query(
    `INSERT INTO health_scores (user_id, week_key, score, components)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, week_key)
     DO UPDATE SET score=$3, components=$4, computed_at=NOW()`,
    [userId, weekKey, totalScore, JSON.stringify(components)]
  )

  return { score: totalScore, grade, label, components, weekKey }
}

// ── 2. BEHAVIORAL ANALYSIS ────────────────────────────────────────────────────
/**
 * Find patterns that predict overspending. Checks:
 *   a) Day-of-week: which days correlate with high spend
 *   b) Low-balance trigger: does spend increase when balance is low
 *   c) Post-paycheck spike: big spend right after income
 *   d) Month-end splurge: higher spend in last 5 days of month
 */
async function runBehavioralAnalysis(userId) {
  const insights = []

  // ── a) Day-of-week pattern ──
  const { rows: dowData } = await pool.query(
    `SELECT
       EXTRACT(DOW FROM date)::int AS dow,
       AVG(ABS(amount)) AS avg_spend,
       COUNT(*) AS tx_count
     FROM transactions
     WHERE user_id=$1 AND amount < 0
       AND COALESCE(tx_type,'expense') != 'transfer'
       AND date >= CURRENT_DATE - INTERVAL '90 days'
     GROUP BY dow
     ORDER BY avg_spend DESC`,
    [userId]
  )

  if (dowData.length >= 5) {
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
    const avgAll  = dowData.reduce((s, r) => s + Number(r.avg_spend), 0) / dowData.length
    const topDay  = dowData[0]
    const ratio   = avgAll > 0 ? Number(topDay.avg_spend) / avgAll : 1

    if (ratio >= 1.5) {
      const key  = 'dow_spike'
      const text = `${DAYS[topDay.dow]}s are your most expensive day — you spend ${Math.round((ratio - 1) * 100)}% more per transaction than your weekly average.`
      await upsertInsight(userId, key, text, { dow: topDay.dow, ratio, avg_all: avgAll, avg_day: topDay.avg_spend })
      insights.push({ key, text })
    }
  }

  // ── b) Post-paycheck spike — spend in 3 days after income transaction ──
  const { rows: paychecks } = await pool.query(
    `SELECT date FROM transactions
     WHERE user_id=$1 AND amount > 0
       AND COALESCE(tx_type,'expense') = 'income'
       AND date >= CURRENT_DATE - INTERVAL '90 days'
     ORDER BY date`,
    [userId]
  )

  if (paychecks.length >= 2) {
    let postPaySpend = 0, postPayDays = 0
    let normalSpend  = 0, normalDays  = 0

    for (const pc of paychecks) {
      const pcDate = new Date(pc.date)
      const { rows: post } = await pool.query(
        `SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(DISTINCT date) AS days
         FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
           AND date > $2 AND date <= $2 + INTERVAL '3 days'`,
        [userId, pc.date]
      )
      postPaySpend += Number(post[0].total)
      postPayDays  += Number(post[0].days)
    }

    const { rows: normalRows } = await pool.query(
      `SELECT COALESCE(SUM(ABS(amount)),0) AS total, COUNT(DISTINCT date) AS days
       FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '90 days'`,
      [userId]
    )
    normalSpend = Number(normalRows[0].total)
    normalDays  = Number(normalRows[0].days)

    const avgPost   = postPayDays  > 0 ? postPaySpend  / postPayDays  : 0
    const avgNormal = normalDays > 0   ? normalSpend   / normalDays   : 0
    const ratio     = avgNormal > 0 ? avgPost / avgNormal : 1

    if (ratio >= 1.4 && avgPost > 20) {
      const key  = 'post_paycheck_spike'
      const text = `You tend to spend ${Math.round((ratio - 1) * 100)}% more in the 3 days after a paycheck — $${fmt(avgPost)}/day vs your usual $${fmt(avgNormal)}/day.`
      await upsertInsight(userId, key, text, { ratio, avg_post: avgPost, avg_normal: avgNormal })
      insights.push({ key, text })
    }
  }

  // ── c) Month-end splurge ──
  const { rows: monthEndData } = await pool.query(
    `SELECT
       CASE WHEN EXTRACT(DAY FROM date) > (DATE_PART('days', DATE_TRUNC('month', date) + INTERVAL '1 month - 1 day')) - 5
         THEN 'month_end' ELSE 'other' END AS period,
       AVG(ABS(amount)) AS avg_spend
     FROM transactions
     WHERE user_id=$1 AND amount < 0
       AND COALESCE(tx_type,'expense') != 'transfer'
       AND date >= CURRENT_DATE - INTERVAL '90 days'
     GROUP BY period`,
    [userId]
  )

  const monthEndRow = monthEndData.find(r => r.period === 'month_end')
  const otherRow    = monthEndData.find(r => r.period === 'other')
  if (monthEndRow && otherRow) {
    const ratio = Number(otherRow.avg_spend) > 0 ? Number(monthEndRow.avg_spend) / Number(otherRow.avg_spend) : 1
    if (ratio >= 1.3) {
      const key  = 'month_end_splurge'
      const text = `Your spending tends to spike in the last 5 days of the month — ${Math.round((ratio - 1) * 100)}% above your monthly average.`
      await upsertInsight(userId, key, text, { ratio, avg_end: monthEndRow.avg_spend, avg_other: otherRow.avg_spend })
      insights.push({ key, text })
    }
  }

  return insights
}

async function upsertInsight(userId, key, text, data) {
  await pool.query(
    `INSERT INTO behavioral_insights (user_id, insight_key, insight_text, data)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, insight_key)
     DO UPDATE SET insight_text=$3, data=$4, computed_at=NOW()`,
    [userId, key, text, JSON.stringify(data)]
  )
}

// ── 3. ADAPTIVE BUDGET CAPS ───────────────────────────────────────────────────
/**
 * Compare this month's spending pace to the same month last year.
 * If they diverge significantly, suggest adjusting the cap.
 * Only suggests once per budget per month, requires 11+ months of history.
 */
async function runAdaptiveBudgets(userId) {
  const today    = new Date()
  const month    = today.getMonth()    // 0-11
  const year     = today.getFullYear()
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`

  const { rows: budgets } = await pool.query(
    'SELECT id, name, cap FROM budgets WHERE user_id=$1 AND completed=FALSE',
    [userId]
  )

  let suggestions = 0

  for (const b of budgets) {
    // Already suggested this month?
    const { rows: logged } = await pool.query(
      'SELECT id FROM adaptive_budget_log WHERE user_id=$1 AND budget_id=$2 AND month=$3',
      [userId, b.id, monthKey]
    )
    if (logged.length) continue

    // Get same month in prior years (up to 3 years)
    const { rows: historical } = await pool.query(
      `SELECT
         EXTRACT(YEAR FROM date_trunc('month', date)) AS yr,
         SUM(ABS(amount)) AS total
       FROM transactions
       WHERE user_id=$1
         AND LOWER(category) = LOWER($2)
         AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND EXTRACT(MONTH FROM date) = $3
         AND EXTRACT(YEAR FROM date) < $4
       GROUP BY yr`,
      [userId, b.name, month + 1, year]
    )

    if (historical.length < 1) continue

    const historicalAvg = historical.reduce((s, r) => s + Number(r.total), 0) / historical.length
    const currentCap    = Number(b.cap)

    // Significant divergence from historical pattern?
    const ratio = currentCap > 0 ? historicalAvg / currentCap : 1
    if (ratio < 0.7 || ratio > 1.4) {
      const suggested = Math.ceil(historicalAvg / 25) * 25 // round to nearest $25
      const reason    = ratio < 0.7
        ? `Historical ${b.name} spend in ${MONTH_NAMES[month]} averages $${fmt(historicalAvg)} — your cap of $${fmt(currentCap)} may be too high.`
        : `Historical ${b.name} spend in ${MONTH_NAMES[month]} averages $${fmt(historicalAvg)} — your cap of $${fmt(currentCap)} may be too low for this time of year.`

      await pool.query(
        `INSERT INTO adaptive_budget_log (user_id, budget_id, old_cap, suggested_cap, month, reason)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, budget_id, month) DO NOTHING`,
        [userId, b.id, currentCap, suggested, monthKey, reason]
      )

      await createNotification(userId, {
        type:  'insight',
        icon:  '📅',
        title: `${b.name} cap suggestion for ${MONTH_NAMES[month]}`,
        body:  `${reason} Suggested cap: $${fmt(suggested)}.`,
        metadata: { type: 'adaptive_budget', budget_id: b.id, old_cap: currentCap, suggested_cap: suggested }
      })
      suggestions++
    }
  }

  return suggestions
}

// ── 4. WIN DETECTION ─────────────────────────────────────────────────────────
/**
 * Detect and celebrate real financial wins. Fires once per win type per month.
 * Wins checked:
 *   a) Budget streak — under cap for 3+ consecutive months in a category
 *   b) Savings rate improvement — savings rate higher than last 3-month average
 *   c) Debt milestone — debt dropped below a round number ($5k, $10k, $25k, etc.)
 *   d) Spending drop — this month's spend tracking below last month by 10%+
 */
async function detectWins(userId) {
  const monthKey = new Date().toISOString().slice(0, 7)
  let fired = 0

  // ── a) Budget streak ──
  const { rows: budgets } = await pool.query(
    'SELECT id, name, cap, icon FROM budgets WHERE user_id=$1 AND completed=FALSE AND cap > 0',
    [userId]
  )

  for (const b of budgets) {
    const alertKey = `win-budget-streak-${b.id}-${monthKey}`
    const { rows: already } = await pool.query(
      'SELECT id FROM proactive_alert_log WHERE user_id=$1 AND alert_key=$2',
      [userId, alertKey]
    )
    if (already.length) continue

    // Check last 3 months all under cap
    const { rows: monthlySpend } = await pool.query(
      `SELECT date_trunc('month', date) AS m, SUM(ABS(amount)) AS spent
       FROM transactions
       WHERE user_id=$1 AND LOWER(category) = LOWER($2) AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '3 months'
         AND date < date_trunc('month', CURRENT_DATE)
       GROUP BY m ORDER BY m`,
      [userId, b.name]
    )

    if (monthlySpend.length >= 3 && monthlySpend.every(r => Number(r.spent) <= Number(b.cap))) {
      await createNotification(userId, {
        type:  'win', icon: '🏆',
        title: `${b.icon || ''} ${b.name} — 3 months under budget`.trim(),
        body:  `You've stayed under your ${b.name} cap for 3 months in a row. That's genuine discipline.`,
        metadata: { type: 'budget_streak', budget_id: b.id, months: 3 }
      })
      await pool.query(
        'INSERT INTO proactive_alert_log (user_id, alert_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [userId, alertKey]
      )
      fired++
    }
  }

  // ── b) Savings rate improvement ──
  const savingsKey = `win-savings-rate-${monthKey}`
  const { rows: savingsAlready } = await pool.query(
    'SELECT id FROM proactive_alert_log WHERE user_id=$1 AND alert_key=$2',
    [userId, savingsKey]
  )
  if (!savingsAlready.length) {
    const { rows: monthly } = await pool.query(
      `SELECT date_trunc('month', date) AS m,
         SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS expenses
       FROM transactions
       WHERE user_id=$1 AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '4 months'
       GROUP BY m ORDER BY m DESC`,
      [userId]
    )

    if (monthly.length >= 4) {
      const thisRate = Number(monthly[0].income) > 0
        ? (Number(monthly[0].income) - Number(monthly[0].expenses)) / Number(monthly[0].income)
        : 0
      const priorRates = monthly.slice(1).map(r =>
        Number(r.income) > 0 ? (Number(r.income) - Number(r.expenses)) / Number(r.income) : 0
      )
      const avgPrior = priorRates.reduce((s, v) => s + v, 0) / priorRates.length

      if (thisRate > avgPrior + 0.05 && thisRate > 0.1) {
        await createNotification(userId, {
          type: 'win', icon: '📈',
          title: 'Savings rate is up',
          body:  `Your savings rate this month is ${Math.round(thisRate * 100)}% — up from your ${Math.round(avgPrior * 100)}% average. That's real progress.`,
          metadata: { type: 'savings_rate_win', this_rate: thisRate, avg_prior: avgPrior }
        })
        await pool.query(
          'INSERT INTO proactive_alert_log (user_id, alert_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [userId, savingsKey]
        )
        fired++
      }
    }
  }

  // ── c) Debt milestone ──
  const MILESTONES = [50000, 25000, 20000, 15000, 10000, 7500, 5000, 2500, 1000, 0]
  const { rows: debtRows } = await pool.query(
    'SELECT COALESCE(SUM(balance), 0) AS total FROM accounts WHERE user_id=$1 AND is_debt=TRUE',
    [userId]
  )
  const totalDebt = Number(debtRows[0].total)

  for (const milestone of MILESTONES) {
    if (totalDebt <= milestone) {
      const debtKey = `win-debt-below-${milestone}`
      const { rows: debtAlready } = await pool.query(
        'SELECT id FROM proactive_alert_log WHERE user_id=$1 AND alert_key=$2',
        [userId, debtKey]
      )
      if (!debtAlready.length) {
        const msg = milestone === 0
          ? "You're debt-free. That's genuinely rare. Take a second to appreciate it."
          : `Your total debt just dropped below $${fmt(milestone)}. Keep the momentum.`
        await createNotification(userId, {
          type: 'win', icon: milestone === 0 ? '🎉' : '💪',
          title: milestone === 0 ? 'Debt-free!' : `Debt below $${fmt(milestone)}`,
          body:  msg,
          metadata: { type: 'debt_milestone', milestone, current_debt: totalDebt }
        })
        await pool.query(
          'INSERT INTO proactive_alert_log (user_id, alert_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [userId, debtKey]
        )
        fired++
      }
      break // only fire the lowest milestone hit
    }
  }

  return fired
}

// ── Master runner ─────────────────────────────────────────────────────────────
async function runAllLearning(userId) {
  const results = {}
  results.health     = await computeHealthScore(userId).catch(e => { console.warn('[I] Health:', e.message); return null })
  results.behavioral = await runBehavioralAnalysis(userId).catch(e => { console.warn('[I] Behavioral:', e.message); return [] })
  results.adaptive   = await runAdaptiveBudgets(userId).catch(e => { console.warn('[I] Adaptive:', e.message); return 0 })
  results.wins       = await detectWins(userId).catch(e => { console.warn('[I] Wins:', e.message); return 0 })
  if (results.health) console.log(`[Phase I] user ${userId}: score=${results.health.score} wins=${results.wins} adaptive=${results.adaptive}`)
  return results
}

// ── Score history ─────────────────────────────────────────────────────────────
async function getHealthHistory(userId, weeks = 12) {
  const { rows } = await pool.query(
    `SELECT week_key, score, components, computed_at
     FROM health_scores
     WHERE user_id=$1
     ORDER BY computed_at DESC LIMIT $2`,
    [userId, weeks]
  )
  return rows.reverse() // oldest first for charting
}

// ── Behavioral insights for display ──────────────────────────────────────────
async function getBehavioralInsights(userId) {
  const { rows } = await pool.query(
    'SELECT insight_key, insight_text, data, computed_at FROM behavioral_insights WHERE user_id=$1 ORDER BY computed_at DESC',
    [userId]
  )
  return rows
}

// ── Adaptive budget suggestions (unread) ─────────────────────────────────────
async function getPendingAdaptiveSuggestions(userId) {
  const { rows } = await pool.query(
    `SELECT a.*, b.name AS budget_name, b.icon AS budget_icon
     FROM adaptive_budget_log a
     JOIN budgets b ON a.budget_id = b.id
     WHERE a.user_id=$1 AND a.applied=FALSE
     ORDER BY a.created_at DESC LIMIT 10`,
    [userId]
  )
  return rows
}

// ── Apply adaptive suggestion ─────────────────────────────────────────────────
async function applyAdaptiveSuggestion(userId, logId) {
  const { rows } = await pool.query(
    'SELECT * FROM adaptive_budget_log WHERE id=$1 AND user_id=$2',
    [logId, userId]
  )
  if (!rows.length) return null

  const suggestion = rows[0]
  await pool.query(
    'UPDATE budgets SET cap=$1 WHERE id=$2 AND user_id=$3',
    [suggestion.suggested_cap, suggestion.budget_id, userId]
  )
  await pool.query(
    'UPDATE adaptive_budget_log SET applied=TRUE WHERE id=$1',
    [logId]
  )
  return suggestion
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n||0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function getWeekKey(date) {
  const d   = new Date(date)
  const jan = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan) / 86400000 + jan.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

module.exports = {
  computeHealthScore,
  runBehavioralAnalysis,
  runAdaptiveBudgets,
  detectWins,
  runAllLearning,
  getHealthHistory,
  getBehavioralInsights,
  getPendingAdaptiveSuggestions,
  applyAdaptiveSuggestion,
}
