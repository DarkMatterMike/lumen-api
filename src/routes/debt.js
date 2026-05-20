/**
 * Phase G — Debt Strategy routes
 *
 * GET  /api/debt                           → full debt summary + both strategies at $0 extra
 * POST /api/debt/compare                   → avalanche vs snowball with custom extra payment
 * POST /api/debt/extra-payment             → impact of extra payment on a single debt
 * POST /api/debt/payoff-opportunities      → manually check for payoff opportunities
 * PATCH /api/debt/:id/minimum-payment      → save minimum payment for a debt account
 */
const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const {
  compareStrategies,
  calcExtraPaymentImpact,
  detectPayoffOpportunities,
  getDebtSummary,
} = require('../utils/debtStrategy')

router.use(requireAuth)

// GET /api/debt — full summary + both strategies at $0 extra
router.get('/', async (req, res, next) => {
  try {
    const summary    = await getDebtSummary(req.user.id)
    if (!summary.debts.length) return res.json({ ...summary, strategies: null })

    const strategies = compareStrategies(summary.debts, 0)
    res.json({ ...summary, strategies })
  } catch (err) { next(err) }
})

// POST /api/debt/compare — run both strategies with a custom extra payment amount
router.post('/compare', async (req, res, next) => {
  try {
    const { extra_payment = 0, debts: customDebts } = req.body
    const extra    = Math.max(0, Number(extra_payment))

    // Use provided debts or fetch from DB
    let debts = customDebts
    if (!debts) {
      const summary = await getDebtSummary(req.user.id)
      debts = summary.debts
    }
    if (!debts?.length) return res.json({ error: 'No debts found', debts: [] })

    const result = compareStrategies(debts, extra)
    res.json({ extra_payment: extra, ...result })
  } catch (err) { next(err) }
})

// POST /api/debt/extra-payment — model extra payment impact on a single debt
router.post('/extra-payment', async (req, res, next) => {
  try {
    const { debt_id, extra_monthly } = req.body
    if (!debt_id || !extra_monthly) {
      return res.status(400).json({ error: 'debt_id and extra_monthly required' })
    }

    const { rows } = await pool.query(
      'SELECT id, name, balance, interest_rate, minimum_payment FROM accounts WHERE id=$1 AND user_id=$2 AND is_debt=TRUE',
      [debt_id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Debt account not found' })

    const a    = rows[0]
    const debt = {
      id:         a.id,
      name:       a.name,
      balance:    Number(a.balance),
      rate:       Number(a.interest_rate || 0),
      minPayment: Number(a.minimum_payment || Math.max(25, Number(a.balance) * 0.02)),
    }

    const impact = calcExtraPaymentImpact(debt, Number(extra_monthly))
    res.json({ debt, extra_monthly: Number(extra_monthly), ...impact })
  } catch (err) { next(err) }
})

// POST /api/debt/payoff-opportunities — trigger payoff opportunity check
router.post('/payoff-opportunities', async (req, res, next) => {
  try {
    const fired = await detectPayoffOpportunities(req.user.id)
    res.json({ success: true, opportunities_found: fired })
  } catch (err) { next(err) }
})

// PATCH /api/debt/:id/minimum-payment — save minimum payment amount for a debt
router.patch('/:id/minimum-payment', async (req, res, next) => {
  try {
    const { minimum_payment } = req.body
    if (minimum_payment == null) return res.status(400).json({ error: 'minimum_payment required' })

    const { rows } = await pool.query(
      'UPDATE accounts SET minimum_payment=$1 WHERE id=$2 AND user_id=$3 AND is_debt=TRUE RETURNING *',
      [Number(minimum_payment), req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Debt account not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
