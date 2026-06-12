/**
 * GET /api/snapshot
 *
 * Assembles a complete financial snapshot for the authenticated user —
 * accounts, recent transactions, budgets, bills/recurring, cash-flow
 * forecast, debt summary, and paycheck allocations — into a single
 * JSON payload the user can copy and share with Claude.
 *
 * All queries run in parallel via Promise.all for speed.
 */

const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { buildForecast } = require('../utils/cashFlowForecast')
const { getDebtSummary } = require('../utils/debtStrategy')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id

    const [
      accountsResult,
      transactionsResult,
      budgetsResult,
      recurringResult,
      debtResult,
      paycheckResult,
      forecastResult,
    ] = await Promise.allSettled([
      // 1. Accounts + net worth
      pool.query(
        `SELECT id, name, institution, mask, type, balance, is_debt,
                include_in_balance, forecast_role, interest_rate, limit_amt, minimum_payment
         FROM accounts WHERE user_id = $1 ORDER BY is_debt ASC, name ASC`,
        [uid]
      ),

      // 2. Transactions — last 90 days (enough for 3-month budget context)
      pool.query(
        `SELECT t.id, t.date, t.amount, t.name, t.merchant_name, t.category,
                t.tx_type, a.name AS account_name
         FROM transactions t
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.user_id = $1
           AND t.date >= CURRENT_DATE - INTERVAL '90 days'
         ORDER BY t.date DESC, t.id DESC
         LIMIT 500`,
        [uid]
      ),

      // 3. Budgets with current-month spend
      pool.query(
        `SELECT b.id, b.name, b.cap, b.icon, b.completed,
                COALESCE(SUM(ABS(t.amount)), 0) AS spent
         FROM budgets b
         LEFT JOIN transactions t
           ON t.user_id = b.user_id
          AND t.category ILIKE b.name
          AND t.amount < 0
          AND COALESCE(t.tx_type, 'expense') != 'transfer'
          AND t.date >= date_trunc('month', CURRENT_DATE)
         WHERE b.user_id = $1
         GROUP BY b.id
         ORDER BY b.cap DESC`,
        [uid]
      ),

      // 4. Recurring / bills
      pool.query(
        `SELECT id, name, amount, type, frequency, day_of_month,
                category, active, icon
         FROM recurring WHERE user_id = $1 AND active = TRUE
         ORDER BY type ASC, amount DESC`,
        [uid]
      ),

      // 5. Debt summary (util function handles the heavy lifting)
      getDebtSummary(uid),

      // 6. Paycheck allocations — most recent plan per account
      pool.query(
        `SELECT pa.id, pa.account_id, a.name AS account_name,
                pa.label, pa.amount, pa.priority, pa.created_at
         FROM paycheck_allocations pa
         LEFT JOIN accounts a ON pa.account_id = a.id
         WHERE pa.user_id = $1
         ORDER BY pa.priority ASC, pa.created_at DESC`,
        [uid]
      ).catch(() => ({ rows: [] })), // graceful — table may not exist on older deploys

      // 7. Cash-flow forecast — 60 days, lightweight
      buildForecast(uid, 60).catch(() => null),
    ])

    // ── Helper to unwrap settled results safely ───────────────
    const ok = (r, fallback) => r.status === 'fulfilled' ? r.value : fallback

    // ── Accounts ──────────────────────────────────────────────
    const accountRows = ok(accountsResult, { rows: [] }).rows
    const netWorth    = accountRows.reduce((sum, a) =>
      a.is_debt ? sum - Number(a.balance) : sum + Number(a.balance), 0)

    // ── Transactions ──────────────────────────────────────────
    const txRows = ok(transactionsResult, { rows: [] }).rows

    // ── Budgets ───────────────────────────────────────────────
    const budgetRows = ok(budgetsResult, { rows: [] }).rows.map(b => ({
      ...b,
      spent: Number(b.spent),
      cap:   Number(b.cap),
      pct:   Number(b.cap) > 0
        ? Math.round((Number(b.spent) / Number(b.cap)) * 100)
        : 0,
    }))
    const totalBudgeted = budgetRows.reduce((s, b) => s + b.cap, 0)
    const totalSpent    = budgetRows.reduce((s, b) => s + b.spent, 0)

    // ── Recurring ─────────────────────────────────────────────
    const recurringRows = ok(recurringResult, { rows: [] }).rows
    const bills   = recurringRows.filter(r => r.type !== 'income')
    const income  = recurringRows.filter(r => r.type === 'income')
    const monthlyBills  = bills.reduce((s, b) => s + Number(b.amount), 0)
    const monthlyIncome = income.reduce((s, i) => s + Number(i.amount), 0)

    // ── Debt ──────────────────────────────────────────────────
    const debt = ok(debtResult, null)

    // ── Paycheck allocations ──────────────────────────────────
    const paycheckRows = ok(paycheckResult, { rows: [] }).rows

    // ── Forecast ─────────────────────────────────────────────
    const forecast = ok(forecastResult, null)
    const forecastSummary = forecast ? {
      startBalance: forecast.startBalance,
      minBalance:   forecast.minBalance,
      minDate:      forecast.minDate,
      crunches:     forecast.crunches || [],
      dailyPace:    forecast.dailyPace,
      days:         60,
      // Include just first 60 data points (one per day) to keep payload lean
      points: (forecast.points || []).slice(0, 60).map(p => ({
        date:    p.date,
        balance: p.balance,
      })),
    } : null

    // ── Assemble bundle ───────────────────────────────────────
    const snapshot = {
      generated_at:  new Date().toISOString(),
      summary: {
        net_worth:       netWorth,
        total_budgeted:  totalBudgeted,
        total_spent_mtd: totalSpent,
        monthly_bills:   monthlyBills,
        monthly_income:  monthlyIncome,
      },
      accounts:    accountRows,
      transactions: txRows,
      budgets: {
        items:          budgetRows,
        total_budgeted: totalBudgeted,
        total_spent:    totalSpent,
        remaining:      totalBudgeted - totalSpent,
      },
      bills_and_recurring: {
        bills,
        income,
      },
      cash_flow_forecast: forecastSummary,
      debt: debt ? {
        total_debt:        debt.totalDebt,
        total_minimum:     debt.totalMinimum,
        debts:             debt.debts,
      } : null,
      paycheck_allocations: paycheckRows,
    }

    res.json(snapshot)
  } catch (err) {
    next(err)
  }
})

module.exports = router
