/**
 * Routes for pending transactions and merge candidate review
 *
 * GET  /api/pending                     → pending transactions + merge candidates
 * POST /api/pending/scan                → scan Gmail for bank alert emails now
 * GET  /api/pending/candidates          → merge candidates awaiting review
 * POST /api/pending/candidates/:id/merge      → user confirms merge
 * POST /api/pending/candidates/:id/separate   → user says keep separate
 * DELETE /api/pending/:id               → dismiss a pending transaction
 */
const express    = require('express')
const router     = express.Router()
const pool       = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const {
  scanBankAlerts,
  getMergeCandidates,
  executeMerge,
  keepSeparate,
} = require('../utils/bankAlertParser')

router.use(requireAuth)

// GET /api/pending — all pending transactions + open merge candidates count
router.get('/', async (req, res, next) => {
  try {
    const [txRes, candidatesRes] = await Promise.all([
      pool.query(
        `SELECT t.*, a.name AS account_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id=$1 AND t.status='pending'
         ORDER BY t.date DESC`,
        [req.user.id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM merge_candidates
         WHERE user_id=$1 AND status='pending_review'`,
        [req.user.id]
      ),
    ])
    res.json({
      pending:           txRes.rows,
      merge_candidate_count: Number(candidatesRes.rows[0]?.count || 0),
    })
  } catch (err) { next(err) }
})

// POST /api/pending/scan — manually trigger Gmail bank alert scan
router.post('/scan', async (req, res, next) => {
  try {
    const result = await scanBankAlerts(req.user.id)
    res.json({ success: true, ...result })
  } catch (err) { next(err) }
})

// GET /api/pending/candidates — merge candidates awaiting review
router.get('/candidates', async (req, res, next) => {
  try {
    const candidates = await getMergeCandidates(req.user.id)
    res.json({ candidates })
  } catch (err) { next(err) }
})

// POST /api/pending/candidates/:id/merge — user confirms merge
router.post('/candidates/:id/merge', async (req, res, next) => {
  try {
    const result = await executeMerge(req.user.id, parseInt(req.params.id))
    res.json({ success: true, ...result })
  } catch (err) { next(err) }
})

// POST /api/pending/candidates/:id/separate — user says keep both
router.post('/candidates/:id/separate', async (req, res, next) => {
  try {
    await keepSeparate(req.user.id, parseInt(req.params.id))
    res.json({ success: true })
  } catch (err) { next(err) }
})

// DELETE /api/pending/:id — dismiss a pending transaction without merging
router.delete('/:id', async (req, res, next) => {
  try {
    // Also dismiss any open merge candidates for this tx
    await pool.query(
      `UPDATE merge_candidates SET status='kept_separate', resolved_at=NOW()
       WHERE (pending_tx_id=$1 OR posted_tx_id=$1) AND user_id=$2 AND status='pending_review'`,
      [req.params.id, req.user.id]
    )
    await pool.query(
      `DELETE FROM transactions WHERE id=$1 AND user_id=$2 AND status='pending'`,
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
