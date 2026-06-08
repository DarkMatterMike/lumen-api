/**
 * debtStrategy.js
 * Phase G — Debt Strategy
 *
 * Exports:
 *  - modelPayoff(debts, extraPayment, strategy)  → month-by-month payoff schedule
 *  - compareStrategies(debts, extraPayment)       → avalanche vs snowball comparison
 *  - calcExtraPaymentImpact(debt, extraMonthly)   → impact of extra payment on one debt
 *  - detectPayoffOpportunities(userId)            → savings > small debt → suggest payoff
 *  - getDebtSummary(userId)                       → all debts with payoff projections
 */

const pool = require('../db/pool')

// ── Core amortization engine ──────────────────────────────────────────────────
/**
 * Model a payoff schedule for a list of debts with a given strategy + extra payment.
 *
 * @param {Array}  debts         — [{ id, name, balance, rate, minPayment }]
 * @param {number} extraPayment  — additional $ per month beyond minimums
 * @param {string} strategy      — 'avalanche' | 'snowball'
 * @returns {Object} { months, totalInterest, totalPaid, schedule, payoffOrder, debtResults }
 */
function modelPayoff(debts, extraPayment = 0, strategy = 'avalanche') {
  if (!debts?.length) return { months: 0, totalInterest: 0, totalPaid: 0, schedule: [], payoffOrder: [], debtResults: [] }

  // Deep copy so we don't mutate input
  let remaining = debts.map(d => ({
    ...d,
    balance:    Math.max(0, Number(d.balance)),
    rate:       Number(d.rate || 0) / 100 / 12, // monthly rate
    minPayment: Math.max(Number(d.minPayment || 0), 10),
    paid:       0,
    interest:   0,
    payoffMonth: null,
  }))

  const schedule    = []
  const payoffOrder = []
  let   month       = 0
  const MAX_MONTHS  = 600 // 50 year ceiling

  while (remaining.some(d => d.balance > 0.01) && month < MAX_MONTHS) {
    month++

    // Sort target debt by strategy
    const active = remaining.filter(d => d.balance > 0.01)
    active.sort((a, b) =>
      strategy === 'avalanche'
        ? b.rate - a.rate                  // highest rate first
        : a.balance - b.balance            // lowest balance first
    )

    // Apply interest to all active debts
    for (const d of remaining) {
      if (d.balance <= 0.01) continue
      const interestCharge = d.balance * d.rate
      d.balance   += interestCharge
      d.interest  += interestCharge
    }

    // Pay minimums on all, then dump extra onto target
    let remainingExtra = extraPayment
    const monthPayments = {}

    for (const d of remaining) {
      if (d.balance <= 0.01) continue
      const payment = Math.min(d.balance, d.minPayment)
      d.balance -= payment
      d.paid    += payment
      monthPayments[d.id] = payment
      if (d.balance <= 0.01 && d.payoffMonth === null) {
        d.payoffMonth = month
        payoffOrder.push({ id: d.id, name: d.name, month, label: monthLabel(month) })
      }
    }

    // Dump snowball/avalanche freed minimums + extra onto target
    // Freed minimums = minimums of already-paid-off debts
    const freedMinimums = remaining
      .filter(d => d.payoffMonth !== null && d.payoffMonth < month)
      .reduce((s, d) => s + d.minPayment, 0)
    remainingExtra += freedMinimums

    if (remainingExtra > 0 && active[0]?.balance > 0.01) {
      const target  = active[0]
      const extra   = Math.min(target.balance, remainingExtra)
      target.balance -= extra
      target.paid    += extra
      monthPayments[target.id] = (monthPayments[target.id] || 0) + extra
      if (target.balance <= 0.01 && target.payoffMonth === null) {
        target.payoffMonth = month
        payoffOrder.push({ id: target.id, name: target.name, month, label: monthLabel(month) })
      }
    }

    schedule.push({ month, payments: { ...monthPayments } })
  }

  const totalInterest = remaining.reduce((s, d) => s + d.interest, 0)
  const totalPaid     = remaining.reduce((s, d) => s + d.paid, 0)

  return {
    months:       month,
    totalInterest: Math.round(totalInterest * 100) / 100,
    totalPaid:    Math.round(totalPaid * 100) / 100,
    payoffDate:   monthLabel(month),
    schedule,
    payoffOrder,
    debtResults: remaining.map(d => ({
      id:          d.id,
      name:        d.name,
      payoffMonth: d.payoffMonth,
      payoffDate:  d.payoffMonth ? monthLabel(d.payoffMonth) : null,
      totalPaid:   Math.round(d.paid * 100) / 100,
      interest:    Math.round(d.interest * 100) / 100,
    })),
  }
}

// ── Compare both strategies ───────────────────────────────────────────────────
function compareStrategies(debts, extraPayment = 0) {
  const avalanche = modelPayoff(debts, extraPayment, 'avalanche')
  const snowball  = modelPayoff(debts, extraPayment, 'snowball')

  const interestSaved  = snowball.totalInterest - avalanche.totalInterest
  const monthsSaved    = snowball.months - avalanche.months
  const winner         = interestSaved > 0 ? 'avalanche' : interestSaved < 0 ? 'snowball' : 'tie'

  return {
    avalanche,
    snowball,
    comparison: {
      winner,
      interestSaved:  Math.abs(Math.round(interestSaved * 100) / 100),
      monthsSaved:    Math.abs(monthsSaved),
      // Snowball wins on motivation (faster first payoff)
      snowballFirstPayoff: snowball.payoffOrder[0],
      avalancheFirstPayoff: avalanche.payoffOrder[0],
      recommendation: buildRecommendation(avalanche, snowball, interestSaved, monthsSaved, debts),
    }
  }
}

function buildRecommendation(avalanche, snowball, interestSaved, monthsSaved, debts) {
  const highestRate    = Math.max(...debts.map(d => Number(d.rate || 0)))
  const hasHighRate    = highestRate >= 18
  const smallestBal   = Math.min(...debts.map(d => Number(d.balance)))
  const manyDebts     = debts.length >= 3

  if (Math.abs(interestSaved) < 50) {
    return 'Both strategies end up nearly identical — pick whichever keeps you motivated.'
  }
  if (hasHighRate && interestSaved > 0) {
    return `Avalanche saves $${fmt(Math.abs(interestSaved))} in interest over ${Math.abs(monthsSaved)} months. With a ${highestRate}% rate in the mix, that matters.`
  }
  if (manyDebts && snowball.payoffOrder[0]?.month < avalanche.payoffOrder[0]?.month) {
    return `Snowball pays off your first debt ${avalanche.payoffOrder[0]?.month - snowball.payoffOrder[0]?.month} months sooner — that early win can keep momentum. Costs $${fmt(Math.abs(interestSaved))} more in interest.`
  }
  return interestSaved > 0
    ? `Avalanche saves $${fmt(Math.abs(interestSaved))} — the mathematically optimal choice.`
    : `Snowball actually saves $${fmt(Math.abs(interestSaved))} here — unusual but true with these balances.`
}

// ── Extra payment impact on a single debt ─────────────────────────────────────
function calcExtraPaymentImpact(debt, extraMonthly) {
  const base  = modelPayoff([debt], 0,            'avalanche')
  const extra = modelPayoff([debt], extraMonthly, 'avalanche')

  const monthsSaved    = base.months - extra.months
  const interestSaved  = base.totalInterest - extra.totalInterest

  return {
    base:  { months: base.months,  payoffDate: base.payoffDate,  totalInterest: base.totalInterest  },
    extra: { months: extra.months, payoffDate: extra.payoffDate, totalInterest: extra.totalInterest },
    monthsSaved,
    interestSaved: Math.round(interestSaved * 100) / 100,
    extraTotal:    Math.round(extraMonthly * extra.months * 100) / 100,
  }
}

// ── Auto-detect payoff opportunities ─────────────────────────────────────────
/**
 * If a user's savings balance exceeds a debt balance, suggest paying it off.
 * Considers: interest rate on debt vs savings rate, liquidity, emergency fund needs.
 */
async function detectPayoffOpportunities(userId) {
  const { createNotification } = require('../routes/notifications')

  const { rows: accounts } = await pool.query(
    'SELECT * FROM accounts WHERE user_id=$1',
    [userId]
  )

  const debts   = accounts.filter(a => a.is_debt && Number(a.balance) > 0)
  const savings = accounts.filter(a => !a.is_debt && (a.type || '').toLowerCase() === 'savings')

  if (!debts.length || !savings.length) return 0

  const totalSavings    = savings.reduce((s, a) => s + Number(a.balance), 0)
  const emergencyBuffer = 1000 // keep at least $1k in savings
  const available       = Math.max(0, totalSavings - emergencyBuffer)

  let fired = 0

  for (const debt of debts) {
    const bal  = Number(debt.balance)
    const rate = Number(debt.interest_rate || 0)

    // Only suggest if: debt balance < available savings AND rate > 5%
    if (bal > available || rate < 5) continue

    const alertKey = `payoff-opp-${debt.id}-${Math.round(bal / 100)}`
    const { rows: existing } = await pool.query(
      'SELECT id FROM proactive_alert_log WHERE user_id=$1 AND alert_key=$2',
      [userId, alertKey]
    )
    if (existing.length) continue

    const savingsAccount = savings.sort((a, b) => Number(b.balance) - Number(a.balance))[0]

    await createNotification(userId, {
      type:  'insight',
      icon:  '💡',
      title: `You could pay off ${debt.name} today`,
      body:  `Your ${debt.name} balance is $${fmt(bal)} at ${rate}% APR. You have $${fmt(totalSavings)} in ${savingsAccount.name} — enough to pay it off and keep $${fmt(totalSavings - bal)} in savings.`,
      metadata: {
        type:            'payoff_opportunity',
        debt_id:         debt.id,
        debt_name:       debt.name,
        debt_balance:    bal,
        debt_rate:       rate,
        savings_id:      savingsAccount.id,
        savings_balance: totalSavings,
      }
    })

    await pool.query(
      'INSERT INTO proactive_alert_log (user_id, alert_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [userId, alertKey]
    )
    fired++
  }

  return fired
}

// ── Get full debt summary for a user ─────────────────────────────────────────
async function getDebtSummary(userId) {
  const { rows: accounts } = await pool.query(
    `SELECT id, name, type, balance, interest_rate, minimum_payment, limit_amt, icon, color, statement_close_day
     FROM accounts WHERE user_id=$1 AND is_debt=TRUE AND balance > 0
     ORDER BY interest_rate DESC NULLS LAST`,
    [userId]
  )

  const debts = accounts.map(a => ({
    id:         a.id,
    name:       a.name,
    type:       a.type,
    balance:    Number(a.balance),
    rate:       Number(a.interest_rate || 0),
    minPayment: Number(a.minimum_payment || Math.max(25, Number(a.balance) * 0.02)),
    limit:      Number(a.limit_amt || 0),
    statementCloseDay: a.statement_close_day != null ? Number(a.statement_close_day) : null,
    icon:       a.icon,
    color:      a.color,
  }))

  const totalDebt     = debts.reduce((s, d) => s + d.balance, 0)
  const totalMinPayment = debts.reduce((s, d) => s + d.minPayment, 0)
  const weightedRate  = totalDebt > 0
    ? debts.reduce((s, d) => s + d.rate * d.balance, 0) / totalDebt
    : 0

  return {
    debts,
    totalDebt:        Math.round(totalDebt * 100) / 100,
    totalMinPayment:  Math.round(totalMinPayment * 100) / 100,
    weightedAvgRate:  Math.round(weightedRate * 100) / 100,
    count:            debts.length,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function monthLabel(months) {
  if (!months) return null
  const d = new Date()
  d.setMonth(d.getMonth() + months)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

module.exports = {
  modelPayoff,
  compareStrategies,
  calcExtraPaymentImpact,
  detectPayoffOpportunities,
  getDebtSummary,
}
