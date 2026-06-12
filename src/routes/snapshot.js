/**
 * GET /api/snapshot
 *
 * Assembles a complete financial snapshot for the authenticated user.
 * Intentionally avoids importing util functions (buildForecast, getDebtSummary)
 * that have complex dependency chains — those are inlined as direct SQL instead,
 * so a failure in one section never silently zeros out another.
 */

const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id
    const errors = {}

    // ── Helper: run a query, never throw ──────────────────────
    async function safe(key, queryText, params) {
      try {
        const { rows } = await pool.query(queryText, params)
        return rows
      } catch (e) {
        errors[key] = e.message
        return []
      }
    }

    // ── 1. Accounts ───────────────────────────────────────────
    const accounts = await safe('accounts',
      `SELECT id, name, institution, mask, type, balance, is_debt,
              include_in_balance, forecast_role, interest_rate, limit_amt, minimum_payment
       FROM accounts
       WHERE user_id = $1
       ORDER BY is_debt ASC, name ASC`,
      [uid]
    )

    // ── 2. Transactions — last 90 days ────────────────────────
    const transactions = await safe('transactions',
      `SELECT t.id, t.date, t.amount, t.name, t.merchant_name,
              t.category, t.tx_type, a.name AS account_name
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = $1
         AND t.date >= CURRENT_DATE - INTERVAL '90 days'
       ORDER BY t.date DESC, t.id DESC
       LIMIT 500`,
      [uid]
    )

    // ── 3. Budgets with current-month spend ───────────────────
    const budgetRows = await safe('budgets',
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
    )
    const budgets = budgetRows.map(b => ({
      ...b,
      spent: Number(b.spent),
      cap:   Number(b.cap),
      pct:   Number(b.cap) > 0 ? Math.round((Number(b.spent) / Number(b.cap)) * 100) : 0,
    }))

    // ── 4. Recurring / bills ──────────────────────────────────
    const recurring = await safe('recurring',
      `SELECT id, name, amount, type, frequency, day_of_month, category, active, icon
       FROM recurring
       WHERE user_id = $1 AND active = TRUE
       ORDER BY type ASC, amount DESC`,
      [uid]
    )
    const bills        = recurring.filter(r => r.type !== 'income')
    const incomeItems  = recurring.filter(r => r.type === 'income')

    // ── 5. Debt accounts ──────────────────────────────────────
    const debtAccounts = await safe('debt',
      `SELECT id, name, institution, balance, interest_rate, minimum_payment, limit_amt, type
       FROM accounts
       WHERE user_id = $1
         AND is_debt = TRUE
       ORDER BY balance DESC`,
      [uid]
    )

    // ── 6. Paycheck allocations ───────────────────────────────
    const paycheckAllocations = await safe('paycheck',
      `SELECT pa.id, pa.account_id, a.name AS account_name,
              pa.label, pa.amount, pa.priority, pa.created_at
       FROM paycheck_allocations pa
       LEFT JOIN accounts a ON pa.account_id = a.id
       WHERE pa.user_id = $1
       ORDER BY pa.priority ASC, pa.created_at DESC`,
      [uid]
    )

    // ── 7. Cash flow forecast (30-day simple projection) ─────
    // Pull recurring items + current balance and project forward
    // without importing the full buildForecast util
    const forecastAccounts = await safe('forecast_accounts',
      `SELECT balance, forecast_role
       FROM accounts
       WHERE user_id = $1
         AND include_in_balance = TRUE
         AND is_debt = FALSE`,
      [uid]
    )
    const startBalance = forecastAccounts.reduce((s, a) => s + Number(a.balance), 0)

    const upcomingRecurring = await safe('forecast_recurring',
      `SELECT name, amount, type, frequency, day_of_month
       FROM recurring
       WHERE user_id = $1 AND active = TRUE`,
      [uid]
    )

    // ── Compute summary figures ───────────────────────────────
    const netWorth       = accounts.reduce((s, a) =>
      a.is_debt ? s - Number(a.balance) : s + Number(a.balance), 0)
    const totalBudgeted  = budgets.reduce((s, b) => s + b.cap, 0)
    const totalSpent     = budgets.reduce((s, b) => s + b.spent, 0)
    const monthlyBills   = bills.reduce((s, b) => s + Number(b.amount), 0)
    const monthlyIncome  = incomeItems.reduce((s, i) => s + Number(i.amount), 0)
    const totalDebt      = debtAccounts.reduce((s, d) => s + Number(d.balance), 0)
    const totalMinimums  = debtAccounts.reduce((s, d) => s + Number(d.minimum_payment || 0), 0)

    // ── Assemble snapshot ─────────────────────────────────────
    const snapshot = {
      generated_at: new Date().toISOString(),
      _errors: Object.keys(errors).length ? errors : undefined,

      summary: {
        net_worth:         netWorth,
        total_budgeted:    totalBudgeted,
        total_spent_mtd:   totalSpent,
        budget_remaining:  totalBudgeted - totalSpent,
        monthly_bills:     monthlyBills,
        monthly_income:    monthlyIncome,
        total_debt:        totalDebt,
        total_minimums:    totalMinimums,
        liquid_balance:    startBalance,
      },

      accounts,

      transactions,

      budgets: {
        items:          budgets,
        total_budgeted: totalBudgeted,
        total_spent:    totalSpent,
        remaining:      totalBudgeted - totalSpent,
      },

      bills_and_recurring: {
        bills,
        income: incomeItems,
      },

      debt: {
        total_debt:     totalDebt,
        total_minimums: totalMinimums,
        accounts:       debtAccounts,
      },

      paycheck_allocations: paycheckAllocations,

      cash_flow_context: {
        current_liquid_balance: startBalance,
        monthly_income:         monthlyIncome,
        monthly_bills:          monthlyBills,
        monthly_discretionary:  totalBudgeted,
        net_monthly:            monthlyIncome - monthlyBills - totalBudgeted,
        upcoming_recurring:     upcomingRecurring,
      },
    }

    res.json(snapshot)
  } catch (err) {
    next(err)
  }
})

module.exports = router
