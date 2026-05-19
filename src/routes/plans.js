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

// Keywords that signal the user wants to SKIP/AVOID a cost (frees up money)
const SAVING_KEYWORDS = [
  'skip', 'cancel', 'avoid', 'defer', "don't pay", 'not pay',
  'forgo', 'hold off', 'pause', 'delay', 'drop', 'cut', 'remove',
  'stop paying', 'not spend', 'save instead', 'skip payment',
]

function detectDirection(question) {
  const q = (question || '').toLowerCase()
  return SAVING_KEYWORDS.some(kw => q.includes(kw)) ? -1 : 1
}

// POST /api/plans — pin a new plan
router.post('/', async (req, res, next) => {
  try {
    const { question, response, amount, direction: clientDirection } = req.body
    if (!question || !response) return res.status(400).json({ error: 'question and response required' })

    // Client can explicitly pass direction; otherwise we detect from question text
    const direction = clientDirection !== undefined
      ? Number(clientDirection)
      : detectDirection(question)

    const { rows } = await pool.query(
      `INSERT INTO plans (user_id, question, response, amount, status, direction)
       VALUES ($1, $2, $3, $4, 'active', $5) RETURNING *`,
      [req.user.id, question, response, amount || null, direction]
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
