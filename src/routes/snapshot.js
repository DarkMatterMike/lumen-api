/**
 * GET /api/snapshot
 *
 * Financial snapshot for Share with Claude.
 * Each query runs independently — one failure never zeros out another,
 * and _errors reports exactly what went wrong.
 *
 * Monthly income/bill totals use monthlyAmount() which correctly
 * expands biweekly items (×26/12 ≈ 2.167) instead of counting
 * each recurring row only once.
 */

const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { monthlyAmount } = require('../db/recurringUtils')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid    = req.user.id
    const errors = {}

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
      `SELECT t.id, t.date, t.amount,
              COALESCE(t.cleaned_name, t.name) AS merchant_name,
              t.name AS raw_name,
              t.category, t.tx_type,
              a.name AS account_name
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
      `SELECT id, name, amount, type, frequency, day_of_month, icon, active, start_date
       FROM recurring
       WHERE user_id = $1 AND active = TRUE
       ORDER BY type ASC, amount DESC`,
      [uid]
    )
    const bills       = recurring.filter(r => r.type !== 'income')
    const incomeItems = recurring.filter(r => r.type === 'income')

    // ── 5. Debt accounts ──────────────────────────────────────
    const debtAccounts = await safe('debt',
      `SELECT id, name, institution, balance, interest_rate, minimum_payment, limit_amt, type
       FROM accounts
       WHERE user_id = $1 AND is_debt = TRUE
       ORDER BY balance DESC`,
      [uid]
    )

    // ── 6. Liquid balance ─────────────────────────────────────
    const forecastAccounts = await safe('forecast_accounts',
      `SELECT balance FROM accounts
       WHERE user_id = $1
         AND include_in_balance = TRUE
         AND is_debt = FALSE`,
      [uid]
    )
    const liquidBalance = forecastAccounts.reduce((s, a) => s + Number(a.balance), 0)

    // ── Summaries — use monthlyAmount() to correctly expand biweekly ──
    // A biweekly paycheck of $X/occurrence = $X × 26/12 ≈ $2.167X per month
    const netWorth       = accounts.reduce((s, a) =>
      a.is_debt ? s - Number(a.balance) : s + Number(a.balance), 0)
    const totalBudgeted  = budgets.reduce((s, b) => s + b.cap, 0)
    const totalSpent     = budgets.reduce((s, b) => s + b.spent, 0)
    const monthlyBills   = bills.reduce((s, b) => s + monthlyAmount(b), 0)
    const monthlyIncome  = incomeItems.reduce((s, i) => s + monthlyAmount(i), 0)
    const totalDebt      = debtAccounts.reduce((s, d) => s + Number(d.balance), 0)
    const totalMinimums  = debtAccounts.reduce((s, d) => s + Number(d.minimum_payment || 0), 0)

    // ── Assemble snapshot ─────────────────────────────────────
    const snapshot = {
      generated_at: new Date().toISOString(),
      ...(Object.keys(errors).length && { _errors: errors }),

      summary: {
        net_worth:        netWorth,
        total_budgeted:   totalBudgeted,
        total_spent_mtd:  totalSpent,
        budget_remaining: totalBudgeted - totalSpent,
        // These are true monthly equivalents — biweekly items counted ×2.167
        monthly_income:   monthlyIncome,
        monthly_bills:    monthlyBills,
        net_monthly:      monthlyIncome - monthlyBills,  // income minus fixed bills only; discretionary budgets are allocations within this remainder
        total_debt:       totalDebt,
        total_minimums:   totalMinimums,
        liquid_balance:   liquidBalance,
      },

      accounts,
      transactions,

      budgets: {
        items:          budgets,
        total_budgeted: totalBudgeted,
        total_spent:    totalSpent,
        remaining:      totalBudgeted - totalSpent,
      },

      // Raw recurring rows + per-item monthly equivalent for context
      bills_and_recurring: {
        bills: bills.map(b => ({ ...b, monthly_equivalent: monthlyAmount(b) })),
        income: incomeItems.map(i => ({ ...i, monthly_equivalent: monthlyAmount(i) })),
      },

      debt: {
        total_debt:     totalDebt,
        total_minimums: totalMinimums,
        accounts:       debtAccounts,
      },

      cash_flow_context: {
        liquid_balance:        liquidBalance,
        monthly_income:        monthlyIncome,
        monthly_fixed_bills:   monthlyBills,
        monthly_discretionary: totalBudgeted,
        net_monthly:           monthlyIncome - monthlyBills,  // income minus fixed bills only
      },
    }

    res.json(snapshot)
  } catch (err) {
    next(err)
  }
})

module.exports = router
