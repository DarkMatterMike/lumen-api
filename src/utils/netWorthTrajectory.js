/**
 * netWorthTrajectory.js
 * Feature 6 — Net Worth Trajectory
 *
 * Exports:
 *  - snapshotNetWorth(userId)          → record today's net worth snapshot
 *  - getNetWorthHistory(userId, months)→ historical snapshots for charting
 *  - projectNetWorth(userId, months)   → forward projection based on savings rate
 */
const pool = require('../db/pool')

async function snapshotNetWorth(userId) {
  const { rows: accounts } = await pool.query(
    'SELECT id, name, balance, is_debt, type, icon FROM accounts WHERE user_id=$1',
    [userId]
  )

  const assets      = accounts.filter(a => !a.is_debt).reduce((s, a) => s + Number(a.balance), 0)
  const liabilities = accounts.filter(a =>  a.is_debt).reduce((s, a) => s + Number(a.balance), 0)
  const netWorth    = assets - liabilities

  const breakdown = accounts.map(a => ({
    id:      a.id,
    name:    a.name,
    balance: Number(a.balance),
    is_debt: a.is_debt,
    type:    a.type,
  }))

  await pool.query(
    `INSERT INTO net_worth_snapshots (user_id, snapshot_date, net_worth, assets, liabilities, breakdown)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
     ON CONFLICT (user_id, snapshot_date)
     DO UPDATE SET net_worth=$2, assets=$3, liabilities=$4, breakdown=$5`,
    [userId, netWorth, assets, liabilities, JSON.stringify(breakdown)]
  )

  return { netWorth, assets, liabilities }
}

async function getNetWorthHistory(userId, months = 12) {
  const { rows } = await pool.query(
    `SELECT snapshot_date, net_worth, assets, liabilities
     FROM net_worth_snapshots
     WHERE user_id=$1 AND snapshot_date >= CURRENT_DATE - ($2 || ' months')::INTERVAL
     ORDER BY snapshot_date ASC`,
    [userId, months]
  )
  return rows
}

async function projectNetWorth(userId, months = 24) {
  // Get current net worth
  const { rows: snap } = await pool.query(
    `SELECT net_worth FROM net_worth_snapshots
     WHERE user_id=$1 ORDER BY snapshot_date DESC LIMIT 1`,
    [userId]
  )
  const currentNW = snap.length ? Number(snap[0].net_worth) : 0

  // Monthly savings rate from last 3 months
  const { rows: savingsRows } = await pool.query(
    `SELECT
       AVG(income - expenses) AS avg_monthly_savings
     FROM (
       SELECT
         date_trunc('month', date) AS m,
         SUM(CASE WHEN amount > 0 AND COALESCE(tx_type,'expense') != 'transfer' THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN amount < 0 AND COALESCE(tx_type,'expense') != 'transfer' THEN ABS(amount) ELSE 0 END) AS expenses
       FROM transactions
       WHERE user_id=$1 AND date >= CURRENT_DATE - INTERVAL '3 months'
       GROUP BY m
     ) monthly`,
    [userId]
  )
  const monthlySavings = Math.max(0, Number(savingsRows[0]?.avg_monthly_savings || 0))

  // Monthly debt paydown (minimum payments)
  const { rows: debtRows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(minimum_payment, balance * 0.02)), 0) AS monthly_paydown
     FROM accounts WHERE user_id=$1 AND is_debt=TRUE AND balance > 0`,
    [userId]
  )
  const monthlyDebtPaydown = Number(debtRows[0]?.monthly_paydown || 0)

  // Total monthly NW improvement
  const monthlyImprovement = monthlySavings + monthlyDebtPaydown

  // Find milestones
  const MILESTONES = [0, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
  const milestones = []

  for (const milestone of MILESTONES) {
    if (currentNW >= milestone) continue
    if (monthlyImprovement <= 0) break
    const monthsNeeded = Math.ceil((milestone - currentNW) / monthlyImprovement)
    if (monthsNeeded <= months) {
      const d = new Date()
      d.setMonth(d.getMonth() + monthsNeeded)
      milestones.push({
        amount:       milestone,
        monthsNeeded,
        date:         d.toISOString().slice(0, 10),
        label:        d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      })
    }
  }

  // Build projection points (monthly)
  const projectionPoints = []
  for (let i = 0; i <= months; i++) {
    const d = new Date()
    d.setMonth(d.getMonth() + i)
    projectionPoints.push({
      date:     d.toISOString().slice(0, 7),
      netWorth: Math.round((currentNW + monthlyImprovement * i) * 100) / 100,
      projected: true,
    })
  }

  return {
    currentNetWorth:    currentNW,
    monthlySavings,
    monthlyDebtPaydown,
    monthlyImprovement: Math.round(monthlyImprovement * 100) / 100,
    projectionPoints,
    milestones,
    crossesZeroAt:      currentNW < 0 && monthlyImprovement > 0
      ? Math.ceil(-currentNW / monthlyImprovement) : null,
  }
}

module.exports = { snapshotNetWorth, getNetWorthHistory, projectNetWorth }
