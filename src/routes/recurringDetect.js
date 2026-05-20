/**
 * GET  /api/recurring-detect/suggestions — get pending suggestions
 * POST /api/recurring-detect/scan        — scan transactions and create suggestions
 * POST /api/recurring-detect/:id/accept  — accept a suggestion → creates recurring item
 * POST /api/recurring-detect/:id/dismiss — dismiss a suggestion
 */
const express    = require('express')
const router     = express.Router()
const requireAuth = require('../middleware/requireAuth')
const { detectRecurringItems, getSuggestions, acceptSuggestion, dismissSuggestion } = require('../utils/recurringDetection')

router.use(requireAuth)

router.get('/suggestions', async (req, res, next) => {
  try {
    const suggestions = await getSuggestions(req.user.id)
    res.json({ suggestions })
  } catch (err) { next(err) }
})

router.post('/scan', async (req, res, next) => {
  try {
    const added = await detectRecurringItems(req.user.id)
    const suggestions = await getSuggestions(req.user.id)
    res.json({ added, suggestions })
  } catch (err) { next(err) }
})

router.post('/:id/accept', async (req, res, next) => {
  try {
    const item = await acceptSuggestion(req.user.id, parseInt(req.params.id))
    res.json({ success: true, item })
  } catch (err) { next(err) }
})

router.post('/:id/dismiss', async (req, res, next) => {
  try {
    await dismissSuggestion(req.user.id, parseInt(req.params.id))
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
