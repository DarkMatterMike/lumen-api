const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/plans — active plans only
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM plans WHERE user_id=$1 AND status='active' ORDER BY created_at DESC",
      [req.user.id]
    )
    res.json({ plans: rows })
  } catch (err) { next(err) }
})

// POST /api/plans — pin a new plan
router.post('/', async (req, res, next) => {
  try {
    const { question, response, amount } = req.body
    if (!question || !response) return res.status(400).json({ error: 'question and response required' })
    const { rows } = await pool.query(
      `INSERT INTO plans (user_id, question, response, amount, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
      [req.user.id, question, response, amount || null]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/plans/:id — complete or dismiss
router.patch('/:id', async (req, res, next) => {
  try {
    const { status } = req.body
    if (!['completed', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'status must be completed or dismissed' })
    }
    const { rows } = await pool.query(
      `UPDATE plans SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *`,
      [status, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
