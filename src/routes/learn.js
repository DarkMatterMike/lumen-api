/**
 * Phase I — Learning & Personalization API routes
 *
 * GET  /api/learn/health          → current health score + history
 * GET  /api/learn/insights        → behavioral insights
 * GET  /api/learn/adaptive        → pending adaptive budget suggestions
 * POST /api/learn/adaptive/:id/apply → apply an adaptive suggestion
 * POST /api/learn/run             → manually trigger full learning pass
 */
const express     = require('express')
const router      = express.Router()
const requireAuth = require('../middleware/requireAuth')
const {
  computeHealthScore,
  runAllLearning,
  getHealthHistory,
  getBehavioralInsights,
  getPendingAdaptiveSuggestions,
  applyAdaptiveSuggestion,
} = require('../utils/learningEngine')

router.use(requireAuth)

// GET /api/learn/health — current score + 12-week history
router.get('/health', async (req, res, next) => {
  try {
    const [current, history] = await Promise.all([
      computeHealthScore(req.user.id),
      getHealthHistory(req.user.id, 12),
    ])
    res.json({ current, history })
  } catch (err) { next(err) }
})

// GET /api/learn/insights — behavioral patterns
router.get('/insights', async (req, res, next) => {
  try {
    const insights = await getBehavioralInsights(req.user.id)
    res.json({ insights })
  } catch (err) { next(err) }
})

// GET /api/learn/adaptive — pending budget cap suggestions
router.get('/adaptive', async (req, res, next) => {
  try {
    const suggestions = await getPendingAdaptiveSuggestions(req.user.id)
    res.json({ suggestions })
  } catch (err) { next(err) }
})

// POST /api/learn/adaptive/:id/apply — apply a suggested cap change
router.post('/adaptive/:id/apply', async (req, res, next) => {
  try {
    const result = await applyAdaptiveSuggestion(req.user.id, req.params.id)
    if (!result) return res.status(404).json({ error: 'Suggestion not found' })
    res.json({ success: true, applied: result })
  } catch (err) { next(err) }
})

// POST /api/learn/run — manually trigger full learning pass
router.post('/run', async (req, res, next) => {
  try {
    const results = await runAllLearning(req.user.id)
    res.json({ success: true, ...results })
  } catch (err) { next(err) }
})

module.exports = router
