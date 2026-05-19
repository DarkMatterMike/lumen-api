const express    = require('express')
const router     = express.Router()
const pool       = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// GET /api/goals
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.*,
              a.name AS account_name,
              CASE
                WHEN g.target_amount > 0
                THEN ROUND((g.current_amount / g.target_amount) * 100, 1)
                ELSE 0
              END AS progress_pct,
              CASE
                WHEN g.target_date IS NOT NULL AND g.monthly_contribution > 0
                THEN CEIL((g.target_amount - g.current_amount) / g.monthly_contribution)
                ELSE NULL
              END AS months_remaining
       FROM goals g
       LEFT JOIN accounts a ON a.id = g.account_id
       WHERE g.user_id = $1 AND g.active = TRUE
       ORDER BY g.created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/goals
router.post('/', requireAuth, async (req, res) => {
  const { name, type, target_amount, current_amount, monthly_contribution, target_date, account_id, icon, color, notes } = req.body
  if (!name || !type || !target_amount) {
    return res.status(400).json({ error: 'name, type, and target_amount are required' })
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO goals (user_id, name, type, target_amount, current_amount, monthly_contribution, target_date, account_id, icon, color, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.user.id, name, type, target_amount, current_amount || 0, monthly_contribution || null, target_date || null, account_id || null, icon || '🎯', color || 'calm', notes || null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/goals/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const allowed = ['name', 'type', 'target_amount', 'current_amount', 'monthly_contribution', 'target_date', 'account_id', 'icon', 'color', 'notes', 'active']
  const updates = Object.keys(req.body).filter(k => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' })

  const setClauses = updates.map((k, i) => `${k} = $${i + 3}`).join(', ')
  const values = [req.params.id, req.user.id, ...updates.map(k => req.body[k])]

  try {
    const { rows } = await pool.query(
      `UPDATE goals SET ${setClauses}, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/goals/:id/contribute — add to current_amount (deposit toward goal)
router.patch('/:id/contribute', requireAuth, async (req, res) => {
  const { amount } = req.body
  if (!amount || isNaN(amount)) return res.status(400).json({ error: 'amount required' })
  try {
    const { rows } = await pool.query(
      `UPDATE goals SET current_amount = current_amount + $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id, amount]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/goals/:id — soft delete (set active = false)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE goals SET active = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
