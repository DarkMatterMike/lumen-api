/**
 * /api/admin — User management (owner-only)
 */
const express    = require('express')
const router     = express.Router()
const pool       = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Access denied' })
  next()
}

router.use(requireAuth, requireOwner)

// GET /api/admin/users
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, created_at, terms_agreed_at,
              (SELECT COUNT(*) FROM accounts WHERE user_id = users.id) AS account_count,
              (SELECT COUNT(*) FROM transactions WHERE user_id = users.id) AS tx_count,
              (SELECT MAX(created_at) FROM refresh_tokens WHERE user_id = users.id AND revoked = FALSE AND expires_at > NOW()) AS last_active
       FROM users
       ORDER BY created_at DESC`
    )
    res.json({ users: rows })
  } catch (err) { next(err) }
})

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body
    const allowed  = ['owner', 'admin', 'user']
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' })

    // Prevent demoting yourself
    if (Number(req.params.id) === req.user.id && role !== 'owner') {
      return res.status(400).json({ error: 'Cannot change your own owner role' })
    }

    const { rows } = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, role`,
      [role, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/admin/users/:id — revoke all sessions permanently
router.delete('/users/:id', async (req, res, next) => {
  try {
    const targetId = Number(req.params.id)
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot revoke your own account' })
    }
    // Hard-delete refresh tokens so user cannot get new access tokens.
    // Their current access token (≤15 min TTL) will expire on its own.
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [targetId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
