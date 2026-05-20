/**
 * Phase D — Cash Flow Forecast routes
 *
 * GET  /api/forecast           — full 90-day projection + crunches + transfer suggestions
 * GET  /api/forecast/points    — just the data points (for charting, lighter payload)
 * POST /api/forecast/alerts    — manually trigger crunch alert check (also runs from cron)
 */
const express  = require('express')
const router   = express.Router()
const requireAuth = require('../middleware/requireAuth')
const {
  buildForecast,
  runCashFlowAlerts,
  checkTransferSuggestions,
} = require('../utils/cashFlowForecast')

router.use(requireAuth)

// GET /api/forecast — full forecast including crunches + transfer suggestions
router.get('/', async (req, res, next) => {
  try {
    const days      = Math.min(parseInt(req.query.days || '90'), 180)
    const forecast  = await buildForecast(req.user.id, days)
    const transfers = await checkTransferSuggestions(req.user.id)
    res.json({ ...forecast, transferSuggestions: transfers })
  } catch (err) { next(err) }
})

// GET /api/forecast/points?days=30 — lightweight: just data points for charting
// Strips event details to keep payload small
router.get('/points', async (req, res, next) => {
  try {
    const days     = Math.min(parseInt(req.query.days || '90'), 180)
    const forecast = await buildForecast(req.user.id, days)

    // Thin the points — return every point but only date + balance
    // For the chart we also include event count so the UI can show dots
    const thinPoints = forecast.points.map(p => ({
      date:       p.date,
      balance:    p.balance,
      eventCount: p.events.length,
      hasIncome:  p.events.some(e => e.type === 'income'),
      hasBill:    p.events.some(e => e.type !== 'income'),
    }))

    res.json({
      points:       thinPoints,
      startBalance: forecast.startBalance,
      dailyPace:    forecast.dailyPace,
      minBalance:   forecast.minBalance,
      minDate:      forecast.minDate,
      crunches:     forecast.crunches,
      threshold:    forecast.threshold,
      days,
    })
  } catch (err) { next(err) }
})

// POST /api/forecast/alerts — trigger crunch alert check
router.post('/alerts', async (req, res, next) => {
  try {
    const result = await runCashFlowAlerts(req.user.id)
    res.json({ success: true, ...result })
  } catch (err) { next(err) }
})

module.exports = router
